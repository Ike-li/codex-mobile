// test/doctor.test.mjs —— 守护 ENV-02：状态库不兼容时，启动即给出可执行提示。
// 守护：ENV-02
// 测什么：给定 app-server 返回的错误，判定是不是 schema 不兼容，以及提示里有没有下一步。
// 不测什么 + 为什么：不真去 spawn codex 探测——那需要真二进制、真状态库，属于 L0 的
//   环境验收而非单元测试；这里测的是「拿到这个错误之后怎么判断」，那部分是纯函数。
//
// 为什么要这条：~/.codex 是全局共享的，库文件名自带版本后缀（state_5、thread_history_1…）。
// 同机器上的 Codex 桌面版一升级就把新迁移写进去，pin 住旧版的本项目再去读自己那版才有的
// 表就扑空。代码一个字没改，环境变了，然后挂。
//
// 目前只有运行时兜底（public/js/thread-actions.js 把错误翻译成人话），没有启动时探测——
// 用户要等到点开会话列表才知道。这条守的是「启动就说清楚」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schemaVerdict, probeSchema } from '../scripts/doctor.js';

test('no such table 判为状态库不兼容', () => {
  const verdict = schemaVerdict('anyhow error chain: no such table: agent_jobs');
  assert.equal(verdict.compatible, false);
});

test('no such column 同样判为不兼容 —— 迁移加列也是这个形态', () => {
  const verdict = schemaVerdict('SqliteFailure: no such column: threads.archived_at');
  assert.equal(verdict.compatible, false,
    '只认 table 不认 column 的话，加列的那类迁移会整族漏过');
});

test('不兼容时给出可执行的下一步，而不只是转述错误', () => {
  const verdict = schemaVerdict('no such table: agent_jobs');
  assert.match(verdict.hint, /\.codex-version/,
    '提示里要指向版本 pin —— 用户下一步该做的是对齐版本，不是重试');
  assert.doesNotMatch(verdict.hint, /稍后再试|重试/,
    '重试对这个故障没用。给假出路比不给更糟：用户会反复试到放弃');
});

test('其它错误不误判为 schema 问题', () => {
  for (const raw of [
    'connection refused',
    'thread not found',
    'permission denied',
    '',
  ]) {
    assert.equal(schemaVerdict(raw).compatible, true,
      `「${raw}」不是 schema 不兼容。误判会把用户支到升级 codex 这条错路上`);
  }
});

// —— probeSchema：把判定接到真实调用上 ——
// request 是外部边界（codex 子进程），注入假的合法；判定逻辑本身用真的。

test('探测成功时报兼容', async () => {
  const verdict = await probeSchema({ request: async () => ({ threads: [] }) });
  assert.equal(verdict.compatible, true);
  assert.equal(verdict.probeError, undefined);
});

test('探测撞上 no such table 时报不兼容并带提示', async () => {
  const verdict = await probeSchema({
    request: async () => { throw new Error('rpc error: no such table: agent_jobs'); },
  });
  assert.equal(verdict.compatible, false);
  assert.match(verdict.hint, /\.codex-version/);
});

test('探测因别的原因失败时不假装通过', async () => {
  const verdict = await probeSchema({
    request: async () => { throw new Error('spawn ENOENT'); },
  });
  assert.equal(verdict.compatible, true, 'ENOENT 不是 schema 问题');
  assert.match(verdict.probeError, /ENOENT/,
    '但探测确实没成功，必须原样报出来——静默当成通过，等于这道检查不存在');
});

test('用只读调用探测，不发起 turn —— 自检不该烧额度', async () => {
  const calls = [];
  await probeSchema({ request: async (method) => { calls.push(method); return {}; } });
  assert.deepEqual(calls, ['thread/list'],
    '只允许 thread/list。turn/start 那类会真的调用模型，'
    + '而 AGENTS.md 规定日常回归不消耗额度');
});

test('判据与运行时兜底用同一份正则，不各写一份', async () => {
  // 两处各写一份的话，上游改了错误文案就只有一边跟着改——而这类"两侧各写一份"的
  // 常量正是同源漏修的高发区。
  const { SCHEMA_MISMATCH } = await import('../public/js/thread-actions.js');
  assert.ok(SCHEMA_MISMATCH instanceof RegExp,
    'thread-actions.js 必须导出 SCHEMA_MISMATCH，让 doctor 复用同一份');
  assert.equal(SCHEMA_MISMATCH.test('no such table: x'), true);
});
