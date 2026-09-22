// test/unit/client-encoding.test.mjs —— 浏览器侧编解码与设备身份。
//
// 这三个函数从 app.js 的 IIFE 搬出来之前完全不可单测（整个文件 0 个 export），
// 而它们各自都有**会静默出错**的边界：算错了不抛异常，只是行为不对。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDeviceToken,
  decodeBase64Text,
  urlBase64ToUint8Array,
} from '../../public/js/util/client-encoding.js';

// globalThis.crypto 是只读 getter，赋值会抛 TypeError——必须走 defineProperty。
function stubCrypto(value) {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
}

// 这条守的是一次真实事故：局域网 http:// 不是 secure context，那里没有
// crypto.randomUUID，裸调它的结果是发消息静默失败。
test('设备身份在没有 randomUUID 的环境里照样生成得出来', () => {
  const real = globalThis.crypto;
  try {
    // 只留 getRandomValues，模拟非 secure context。
    // globalThis.crypto 在 Node 里是只读 getter，直接赋值会抛，必须 defineProperty。
    stubCrypto({ getRandomValues: bytes => real.getRandomValues(bytes) });
    const token = createDeviceToken();
    assert.match(token, /^dev_[0-9a-f]{32}$/,
      '回落路径走 randomId()：16 字节 / 32 个 hex，与 UUIDv4 的 122 位同量级');
    assert.notEqual(createDeviceToken(), token, '两次生成不能相同');
  } finally {
    stubCrypto(real);
  }
});

test('有 randomUUID 时用它，前缀始终是 dev_', () => {
  const token = createDeviceToken();
  assert.match(token, /^dev_/);
  assert.notEqual(createDeviceToken(), token);
});

// 没有 Web Crypto 时必须**抛**，不能退回 Math.random——设备令牌是长期身份凭证，
// 可预测的令牌等于把设备身份送人。
test('完全没有 Web Crypto 时报错，不退回可预测的随机数', () => {
  const real = globalThis.crypto;
  try {
    stubCrypto(undefined);
    assert.throws(() => createDeviceToken(), /Web Crypto is required/);
    stubCrypto({});
    assert.throws(() => createDeviceToken(), /Web Crypto is required/);
  } finally {
    stubCrypto(real);
  }
});

// VAPID 公钥是 URL-safe base64 且不带补位。补位或字母表换错的表现是订阅推送时抛
// InvalidCharacterError——那句报错完全看不出是密钥格式的问题。
test('URL-safe base64 的补位与字母表都要还原', () => {
  const bytes = Uint8Array.from([0xfb, 0xff, 0xbe, 0x00, 0x01, 0x02]);
  const standard = Buffer.from(bytes).toString('base64');          // 含 + / 和 =
  const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.match(urlSafe, /[-_]/, '前置：这段测试数据必须真的含 URL-safe 字符');

  assert.deepEqual([...urlBase64ToUint8Array(urlSafe)], [...bytes],
    '去掉补位、换过字母表的输入要能还原成原字节');
  assert.deepEqual([...urlBase64ToUint8Array(standard)], [...bytes],
    '带补位的标准写法也要能收');
});

test('URL-safe base64 对各种长度的补位都算得对', () => {
  for (let length = 1; length <= 12; length += 1) {
    const bytes = Uint8Array.from({ length }, (_, index) => index * 7 + 1);
    const urlSafe = Buffer.from(bytes).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.deepEqual([...urlBase64ToUint8Array(urlSafe)], [...bytes],
      `${length} 字节：补位算错的话这里长度就对不上`);
  }
  assert.deepEqual([...urlBase64ToUint8Array('')], []);
});

// atob 给的是 latin-1 字节序列，必须过 TextDecoder。省掉那一步的表现是
// 中文附件预览成乱码——不报错，只是看不懂。
test('base64 文本按 UTF-8 解码，多字节字符不会变成乱码', () => {
  const text = '你好，world 🌏';
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  assert.equal(decodeBase64Text(encoded), text);
  assert.equal(decodeBase64Text(Buffer.from('plain', 'utf8').toString('base64')), 'plain');
});

// ⚠ null 这一条是搬迁时改过行为的地方，值得单独说：atob 会把非字符串**强制成字符串**，
// 而 `atob(null)` 实际解的是 "null" —— 那恰好是合法 base64，原实现因此返回三个乱码字符
// 而不是空串。try/catch 挡不住它，因为根本没抛。
test('base64 解不出来时给空串，不让一个坏附件炸掉整块预览', () => {
  for (const bad of ['!!!!', null, undefined, {}, 123, []]) {
    assert.equal(decodeBase64Text(bad), '', `${String(bad)} 应当安静地给空串`);
  }
});
