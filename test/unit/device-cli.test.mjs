// test/unit/device-cli.test.mjs —— `node scripts/device.js list` 的输出格式。
//
// 为什么有这条：trusted-devices.json 的条目从「字符串数组」演进成了「对象数组」
// （devices.js 里至今留着 typeof entry === 'string' 的兼容分支就是迁移痕迹），
// 而 list 命令没跟着改，把对象直接塞进模板字符串，实测打印出
// `[1] ID: [object Object]`。数据没坏，但「我批准过哪些设备」这个安全审计入口是瞎的。
//
// 测的是格式化这一层的纯函数，不 spawn 子进程——照 doctor.test.mjs 的先例：
// 真跑 CLI 要准备数据文件和进程，那是环境验收，而这里的缺陷完全在格式化里。
import test from 'node:test';
import assert from 'node:assert/strict';

import { formatTrustedDevice } from '../../scripts/device.js';

const RECORD = {
  deviceToken: 'dev_dc0f4d9b7ec802e382b2e8142b1ed724',
  ip: '192.168.1.196',
  userAgent: 'Mozilla/5.0 (Linux; Android 10; K) Chrome/152.0.0.0 Mobile Safari/537.36',
  approvedAt: 1789320644069,
  lastSeenAt: 1789320644069,
  secretHash: null,
};

test('受信任设备显示真实 ID，不是 [object Object]', () => {
  const text = formatTrustedDevice(RECORD, 0).join('\n');
  assert.match(text, /dev_dc0f4d9b7ec802e382b2e8142b1ed724/);
  assert.doesNotMatch(text, /\[object Object\]/);
});

// 撤销设备时要认得出是哪一台。只有一串 token 的话，两台设备摆在一起没法区分。
test('带上 IP 与批准时间，撤销时认得出是哪台', () => {
  const text = formatTrustedDevice(RECORD, 0).join('\n');
  assert.match(text, /192\.168\.1\.196/, '没有 IP 就分不清是哪台设备');
  assert.match(text, /2026/, '没有批准时间就不知道这条是什么时候加的');
});

// devices.js 至今兼容字符串条目，这里不能比它更严——早期批准的设备仍在文件里。
test('历史的字符串条目照样显示得出来', () => {
  const text = formatTrustedDevice('dev_legacy_plain_string', 0).join('\n');
  assert.match(text, /dev_legacy_plain_string/);
  assert.doesNotMatch(text, /\[object Object\]/);
});

// 手改过的文件、跨版本写入的半截记录都可能缺字段。审计入口不该因此炸掉，
// 少一个字段的代价是那一行信息不全，不是整个 list 命令不可用。
test('字段缺失时不抛，也不打印 undefined', () => {
  for (const broken of [{ deviceToken: 'dev_x' }, {}, null]) {
    const lines = formatTrustedDevice(broken, 0);
    assert.ok(Array.isArray(lines) && lines.length > 0);
    assert.doesNotMatch(lines.join('\n'), /undefined|NaN|\[object Object\]/);
  }
});

test('序号跟着传入的下标走', () => {
  assert.match(formatTrustedDevice(RECORD, 2)[0], /\[3\]/);
});
