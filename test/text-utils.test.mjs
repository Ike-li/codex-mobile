// test/text-utils.test.mjs —— 共享截断函数的边界。
//
// 为什么单独建这个文件：全景盘点时按「每个生产模块，测试里都 import 了吗」扫了一遍，
// text-utils.js 是唯一一个**任何测试都没提到过**的模块。它被 approval-broker 用来
// 截断审批摘要与技能问题的正文（TOOL_SUMMARY_CAP），也就是说它的输出会直接出现在
// 用户要据以做批准决定的那块屏幕上——截多了会把关键信息切掉，截少了会把超长 diff
// 整个灌进推送通知。
//
// 它被间接执行过（approval-broker 的测试会跑到），但没有任何断言盯着边界本身。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { truncate, truncatePayload } from '../text-utils.js';

test('truncate: 不超过上限时原样返回，正好等于上限也不动', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcde', 5), 'abcde', '正好等于上限是「没超」，不该加截断标记');
  assert.equal(truncate('', 5), '');
});

test('truncate: 超过上限时截到上限并附上标记', () => {
  assert.equal(truncate('abcdef', 5), 'abcde …（已截断）');
  // 截断标记不计入上限——它是加在后面的，不是从内容里挤出来的。
  assert.equal(truncate('abcdef', 5).startsWith('abcde'), true);
});

test('truncate: 调用方可以换掉截断标记', () => {
  // approval-broker 用的是英文标记（那段文本会进审计日志和推送）。
  assert.equal(truncate('abcdef', 5, ' ... (truncated)'), 'abcde ... (truncated)');
  assert.equal(truncate('abcdef', 5, ''), 'abcde', '空标记等于只截不标');
});

// 非字符串一律给空串，而不是让 .length 在调用点抛。approval-broker 传进来的
// change?.diff / question?.header 都可能是 undefined——上游没给这个字段是常态。
test('truncate: 非字符串给空串，不把判空的责任推给调用方', () => {
  for (const value of [undefined, null, 123, {}, [], true]) {
    assert.equal(truncate(value, 5), '', `${String(value)} 不是字符串，应当归一成空串`);
  }
});

// ---- truncatePayload：结构化载荷的限长 ----
//
// 从 agent-appserver.js 搬过来的（原先是模块私有函数，没有任何测试直接调过，
// 变异跑出 8 个存活）。它用在工具卡片上：上游一条 item 可能带着整个 diff 或几万行输出，
// 原样发给浏览器会把消息列表撑爆，而用户真正要看的只是前面那一小段。

test('truncatePayload: 字符串按 cap 截断，其余标量原样返回', () => {
  assert.equal(truncatePayload('abcdef', 3), 'abc …（已截断）');
  assert.equal(truncatePayload('abc', 3), 'abc');
  for (const value of [42, true, false, null, undefined]) {
    assert.equal(truncatePayload(value, 3), value, `${String(value)} 不是字符串，原样返回`);
  }
});

test('truncatePayload: 数组与对象各自最多留 50 项，嵌套里的字符串同样截断', () => {
  assert.equal(truncatePayload(Array.from({ length: 200 }, (_, i) => i), 10).length, 50);
  assert.equal(
    Object.keys(truncatePayload(Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`k${i}`, i])), 10)).length, 50);

  assert.deepEqual(truncatePayload({ a: ['abcdef'], b: 'xy' }, 3),
    { a: ['abc …（已截断）'], b: 'xy' }, '嵌套进去的字符串也要截');
});

// 深度上界防的是**自引用结构**：没有它，一个循环引用会让这里无限递归直到爆栈。
test('truncatePayload: 超过深度上界时收敛成空容器，循环引用不会爆栈', () => {
  assert.deepEqual(truncatePayload({ a: { b: { c: { d: { e: 'deep' } } } } }, 10),
    { a: { b: { c: { d: {} } } } }, '第 5 层被收敛成空对象');
  assert.deepEqual(truncatePayload([[[[['deep']]]]], 10), [[[[[]]]]]);

  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  assert.deepEqual(truncatePayload(cyclic, 10),
    { name: 'root', self: { name: 'root', self: { name: 'root', self: { name: 'root', self: {} } } } },
    '循环引用靠深度上界收住，不能爆栈');
});
