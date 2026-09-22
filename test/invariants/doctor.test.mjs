// test/invariants/doctor.test.mjs —— 守护 ENV-02：状态库不兼容时，启动即给出可执行提示。
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
import { EventEmitter } from 'node:events';
import { schemaVerdict, probeSchema, createProbeChannel } from '../../scripts/doctor.js';

// 等一个只由 unref 定时器驱动的 promise 时，必须有东西吊着事件循环。
// 请求超时定时器在生产代码里是 unref 的（线上有 HTTP listener 吊着，无影响），测试里没有，
// 于是事件循环先排空，node --test 判定「promise 仍挂起而事件循环已结束」，把用例标成
// cancelled——而 cancelled 不计入 fail，汇总看起来像通过（check-test-summary.js 正是为
// 这个而设，它把 cancelled≠0 拦成红）。
// app-server-transport.test.mjs 与 app-server-host.test.mjs 已各有一份同源实现：
// test/ 下的用例彼此不 import，三处各自保持自包含。这里是这个病的第三次复发——
// 前两次修的时候解法都没传过来。
async function withLiveEventLoop(fn) {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
}

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
  const { SCHEMA_MISMATCH } = await import('../../public/js/session/thread-actions.js');
  assert.ok(SCHEMA_MISMATCH instanceof RegExp,
    'thread-actions.js 必须导出 SCHEMA_MISMATCH，让 doctor 复用同一份');
  assert.equal(SCHEMA_MISMATCH.test('no such table: x'), true);
});

// ---------------------------------------------------------------------------
// 探测得**真的跑起来**才算数
// ---------------------------------------------------------------------------
// 上面那几条测的都是「拿到结果之后怎么判断」，它们从第一天起就是绿的。而 2026-09-15
// 真跑一次 npm run doctor 才发现 SCHEMA_PROBE 从加上那天起一次都没成功过，
// 而且是**两层错误叠在一起**：
//
//   ① 宿主写 `new AppServerHost()`，而它第一行就是 `if (!registry) throw`。
//      异常被外层 try 吞成 probeError，输出恒为 ⚠️「探测没能完成」。
//   ② 修掉 ① 之后才暴露出更深的一层：`AppServerHost.request` 的第一个参数是
//      **runtime 不是 method**。`host.request('thread/list', {…})` 被解释成
//      runtime='thread/list'、method={…}，app-server 收到一个对象当方法名，
//      永远不回——doctor 直接挂死，比 warn 更糟。
//
// 结论是选错了边界：AppServerHost 的职责是按 runtime 路由，而探测没有 runtime。
// 探测该走下一层的 AppServerTransport。
//
// 教训：判定层的纯函数测得再厚，也证明不了**有人以正确的参数调用过它们**。
// 接线本身要有一条测，否则第一层错误会把第二层挡在后面。

/** 一个照 JSON-RPC 规矩应答的假 app-server：请求回结果，通知不回。 */
function fakeAppServer({ answer = () => ({}), silent = false } = {}) {
  const child = new EventEmitter();
  const methods = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write(chunk) {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const frame = JSON.parse(line);
        methods.push(frame.method);
        if (silent || frame.id === undefined) continue;
        const payload = `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: answer(frame.method) })}\n`;
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(payload)));
      }
      return true;
    },
  };
  child.kill = () => true;
  return { child, methods };
}

test('探测通道建得出来，且用配置里那个 codexBin 与主工作区', async () => {
  // doctor 的全部价值在于「它看到的 == server 启动时会看到的」。探测却去跑 PATH 上
  // 另一个 codex 的话，报出来的兼容性结论与实际要用的那个二进制无关。
  const spawned = [];
  const probe = await createProbeChannel({
    codexBin: '/opt/custom/codex',
    cwd: '/srv/work',
    spawnImpl: (bin, args, opts) => { spawned.push({ bin, cwd: opts?.cwd }); return fakeAppServer().child; },
  });
  assert.deepEqual(spawned, [], '构造不该 spawn——建个对象就拉子进程的话，--skip-probe 也躲不掉');

  await probe.request('thread/list', { pageSize: 1 });
  assert.deepEqual(spawned, [{ bin: '/opt/custom/codex', cwd: '/srv/work' }]);
  await probe.dispose();
});

test('先 initialize 握手再发 thread/list——顺序反了 app-server 不回', async () => {
  const server = fakeAppServer();
  const probe = await createProbeChannel({
    codexBin: '/fake/codex', cwd: '/w', spawnImpl: () => server.child,
  });
  await probe.request('thread/list', { pageSize: 1 });
  assert.deepEqual(server.methods, ['initialize', 'initialized', 'thread/list'],
    'initialized 通知也要发，它是协议握手的第二步');
  await probe.dispose();
});

test('握手参数与 server 用的是同一份，不各写一份', async () => {
  // 两处各写一份的话，上游改了 capabilities 形状就只有一边跟着改，
  // 而 doctor 报出来的兼容性结论会与实际连接的那次不同——正是它最不该出错的地方。
  const { buildInitializeParams } = await import('../../src/agent/app-server-host.js');
  const sent = [];
  const server = fakeAppServer();
  server.child.stdin.write = chunk => {
    for (const line of String(chunk).split('\n').filter(Boolean)) sent.push(JSON.parse(line));
    const frame = sent.at(-1);
    if (frame.id !== undefined) {
      queueMicrotask(() => server.child.stdout.emit('data',
        Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} })}\n`)));
    }
    return true;
  };
  const probe = await createProbeChannel({
    codexBin: '/fake/codex', cwd: '/w', spawnImpl: () => server.child,
  });
  await probe.request('thread/list', {});
  assert.deepEqual(sent[0].params, buildInitializeParams({ experimentalApi: false }));
  await probe.dispose();
});

test('请求带超时——app-server 不回时 doctor 必须停下来，不能永远挂着', async () => {
  // 这条是真踩出来的：修掉构造那个 bug 之后，探测第一次真的跑起来，
  // 却因为参数顺序错误发出了一个畸形请求，app-server 不回，npm run doctor 挂死。
  // **挂死比 warn 更糟**——warn 至少还能看到其余十二项。
  await withLiveEventLoop(async () => {
    const probe = await createProbeChannel({
      codexBin: '/fake/codex', cwd: '/w', timeoutMs: 40,
      spawnImpl: () => fakeAppServer({ silent: true }).child,
    });
    // 卡在 initialize 而不是 thread/list——握手就超时，比发完请求再等更早停下来。
    await assert.rejects(() => probe.request('thread/list', {}), /initialize timed out/i);
    await probe.dispose();
  });
});
