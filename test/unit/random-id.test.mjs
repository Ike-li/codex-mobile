// test/unit/random-id.test.mjs —— 客户端随机 id 的降级路径。
//
// 这个模块此前**没有任何测试 import 过它**（全景盘点时按模块扫出来的空洞之一）。
// 它现在同时是 clientRequestId 和设备令牌的来源，两者都靠「不撞号」成立：
// 投递去重和设备身份都建在它上面。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { randomId } from '../../public/js/random-id.js';

function stubCrypto(value) {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
}

test('有 randomUUID 时直接用它', () => {
  const real = globalThis.crypto;
  try {
    stubCrypto({ randomUUID: () => 'fixed-uuid', getRandomValues: () => {} });
    assert.equal(randomId(), 'fixed-uuid');
  } finally {
    stubCrypto(real);
  }
});

// 非 secure context（局域网 http://）没有 randomUUID，只有 getRandomValues。
// 这是本项目的主要访问路径之一，降级不生效的后果是发消息静默失败。
test('没有 randomUUID 时回落到 getRandomValues，给出 32 个 hex', () => {
  const real = globalThis.crypto;
  try {
    stubCrypto({ getRandomValues: bytes => real.getRandomValues(bytes) });
    const id = randomId();
    assert.match(id, /^[0-9a-f]{32}$/, '16 字节 = 128 位，与 UUIDv4 的随机位数同量级');
    assert.notEqual(randomId(), id);
  } finally {
    stubCrypto(real);
  }
});

// 每个字节都要补足两位。漏掉 padStart 的话 0x0a 会变成 "a"，长度不定且熵被削——
// 而这种 bug 只在随机数**恰好**小于 0x10 时才现形，靠人眼审查几乎看不出来。
test('每个字节补足两位十六进制，长度恒定', () => {
  const real = globalThis.crypto;
  try {
    // 全 0 字节：不补位的话结果是空串而不是 32 个 0。
    stubCrypto({ getRandomValues: bytes => bytes.fill(0) });
    assert.equal(randomId(), '0'.repeat(32));
    stubCrypto({ getRandomValues: bytes => bytes.fill(0x0a) });
    assert.equal(randomId(), '0a'.repeat(16));
    stubCrypto({ getRandomValues: bytes => bytes.fill(0xff) });
    assert.equal(randomId(), 'f'.repeat(32));
  } finally {
    stubCrypto(real);
  }
});

// 没有 Web Crypto 时必须抛，不能退回 Math.random——可预测的 id 意味着设备可被冒充、
// 请求 id 可被撞号。public-shell-guard 有一条绊线禁止 Math.random 出现在客户端。
test('完全没有 Web Crypto 时报错，不退回可预测的随机数', () => {
  const real = globalThis.crypto;
  try {
    for (const stub of [undefined, {}, { randomUUID: 'not a function' }]) {
      stubCrypto(stub);
      assert.throws(() => randomId(), /Web Crypto is required/, `crypto=${JSON.stringify(stub)}`);
    }
  } finally {
    stubCrypto(real);
  }
});
