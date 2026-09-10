// test/agent-appserver-branches.test.mjs —— 补齐 ThreadRuntime 此前未覆盖的
// 错误路径、进程生命周期、JSON-RPC 请求/响应闭环与边界分支。
// 与 agent-appserver.test.mjs(通知映射契约)互补,聚焦「可观察行为」而非镜像实现:
// 失败恢复、resume vs 新建、队列满、进程死亡、附件路径不外泄等。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadRuntime } from '../agent-appserver.js';

function makeSession(overrides = {}) {
  const events = [];
  const session = new ThreadRuntime({
    instanceId: 'inst_branch',
    resumeId: null,
    cwd: '/tmp/work',
    // 见 agent-appserver.test.mjs：字面量 'codex' 会引入对宿主机 PATH 的隐式依赖。
    codexBin: process.execPath,
    idleTimeoutMs: 600000,
    onEvent: env => events.push(env),
    onSessionId: () => {},
    onExit: () => {},
    ...overrides,
  });
  return { session, events };
}
const byType = (events, type) => events.filter(e => e.type === type);
const readJsonl = path => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
// 注入假子进程,拦截写往 app-server stdin 的 JSON-RPC(外部边界)。
function fakeChild() {
  const writes = [];
  return { writes, child: { stdin: { write: s => writes.push(s) } } };
}

async function waitFor(predicate, timeoutMs = 100) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

// ---- 构造默认值 ----

test('constructor: 缺省 codexBin/idleTimeout 使用默认值', () => {
  const s = new ThreadRuntime({ instanceId: 'i', cwd: '/tmp', onEvent() {}, onSessionId() {}, onExit() {} });
  assert.equal(s.codexBin, 'codex');
  assert.equal(s.idleTimeoutMs, 600000);
});

test('statusPayload exposes the active turn routing identity', () => {
  const { session } = makeSession();
  session.sessionId = 'thr_status';
  session.currentTurnId = 'turn_status';

  assert.equal(session.statusPayload('routing').turnId, 'turn_status');
});

// ---- JSON-RPC 请求/响应闭环 ----

test('request: 写出 {method,id,params} 并在响应到达时 resolve', async () => {
  const { session } = makeSession();
  const { writes, child } = fakeChild();
  session.child = child; // 使 spawnIfNeeded 短路,不真正 spawn
  const p = session.request('thread/start', { cwd: '/tmp/work' });
  const sent = JSON.parse(writes[0]);
  assert.equal(sent.method, 'thread/start');
  assert.equal(sent.id, 1);
  assert.deepEqual(sent.params, { cwd: '/tmp/work' });
  session.handleLine(JSON.stringify({ id: sent.id, result: { thread: { id: 'thr_1' } } }));
  assert.deepEqual(await p, { thread: { id: 'thr_1' } });
  assert.equal(session.pending.size, 0);
});

test('request: 响应带 error 时 reject', async () => {
  const { session } = makeSession();
  const { writes, child } = fakeChild();
  session.child = child;
  const p = session.request('turn/start', {});
  const id = JSON.parse(writes[0]).id;
  session.handleLine(JSON.stringify({ id, error: { message: '越权' } }));
  await assert.rejects(p, /越权/);
  assert.equal(session.pending.size, 0);
});

test('rpc observability: logs redacted client requests, responses, and errors with counters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-rpc-observe-'));
  const rpcLogPath = join(dir, 'rpc-observe.jsonl');
  try {
    const { session } = makeSession({ cwd: dir, rpcLogPath });
    const { writes, child } = fakeChild();
    session.child = child;
    const fakeProjectKey = ['sk', 'proj', '1234567890abcdefghijkl'].join('-');
    const fakeProjectKeyInError = ['sk', 'proj', 'abcdefghijklmno'].join('-');

    const p = session.request('turn/start', {
      cwd: '/Users/raylee/private-project',
      apiKey: fakeProjectKey,
      input: [{ type: 'text', text: 'prompt secret should not be logged' }],
    });
    const sent = JSON.parse(writes[0]);
    session.handleLine(JSON.stringify({
      id: sent.id,
      result: {
        thread: { id: 'thr_1' },
        dataBase64: 'YWJjZA==',
        refreshToken: 'refresh-secret-1234567890',
      },
    }));

    assert.deepEqual(await p, {
      thread: { id: 'thr_1' },
      dataBase64: 'YWJjZA==',
      refreshToken: 'refresh-secret-1234567890',
    });

    const failing = session.request('account/read', {});
    const failingId = JSON.parse(writes[1]).id;
    session.handleLine(JSON.stringify({
      id: failingId,
      error: { code: -32603, message: `bad token ${fakeProjectKeyInError}` },
    }));
    await assert.rejects(failing, /bad token/);

    const mode = statSync(rpcLogPath).mode & 0o777;
    assert.equal(mode, 0o600);

    const raw = readFileSync(rpcLogPath, 'utf8');
    assert.doesNotMatch(raw, /sk-proj-/);
    assert.doesNotMatch(raw, /prompt secret should not be logged/);
    assert.doesNotMatch(raw, /refresh-secret/);
    assert.doesNotMatch(raw, /YWJjZA==/);
    assert.doesNotMatch(raw, /raylee/);

    const lines = readJsonl(rpcLogPath);
    assert.deepEqual(lines.map(line => line.frame), ['request', 'response', 'request', 'response']);
    assert.deepEqual(lines.map(line => line.method), ['turn/start', 'turn/start', 'account/read', 'account/read']);
    assert.equal(lines[3].error.code, -32603);

    const stats = session.statusPayload('rpc_observe').rpcStats;
    assert.equal(stats.clientRequests, 2);
    assert.equal(stats.clientResponses, 2);
    assert.equal(stats.errors, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rpc observability: logs notifications and server requests without sensitive fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-rpc-observe-'));
  const rpcLogPath = join(dir, 'rpc-observe.jsonl');
  try {
    const { session } = makeSession({ cwd: dir, rpcLogPath });
    const { child } = fakeChild();
    session.child = child;

    session.handleLine(JSON.stringify({
      method: 'thread/compacted',
      params: { threadId: 'thr_1', turnId: 'turn_1' },
    }));
    session.handleLine(JSON.stringify({
      method: 'item/tool/requestUserInput',
      id: 99,
      params: {
        threadId: 'thr_1',
        questions: [{ id: 'q1', question: 'Paste the password', isSecret: true }],
        accessToken: 'secret-token-1234567890',
      },
    }));

    const raw = readFileSync(rpcLogPath, 'utf8');
    assert.doesNotMatch(raw, /secret-token/);
    assert.match(raw, /thread\/compacted/);
    assert.match(raw, /item\/tool\/requestUserInput/);

    const lines = readJsonl(rpcLogPath);
    assert.deepEqual(lines.map(line => line.frame), ['notification', 'server_request']);
    assert.equal(lines[1].id, 99);

    const stats = session.statusPayload('rpc_observe').rpcStats;
    assert.equal(stats.serverNotifications, 1);
    assert.equal(stats.serverRequests, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('request: app-server -32001 背压错误会退避重试并透出拥塞状态', async () => {
  const { session, events } = makeSession();
  const { writes, child } = fakeChild();
  session.child = child;

  const p = session.request('thread/list', {}, {
    maxBackpressureRetries: 2,
    backpressureBaseMs: 1,
  });

  const first = JSON.parse(writes[0]);
  session.handleLine(JSON.stringify({
    id: first.id,
    error: { code: -32001, message: 'Server overloaded; retry later.' },
  }));

  await waitFor(() => writes.length === 2);
  const retryNotice = byType(events, 'system').at(-1);
  assert.equal(retryNotice.payload.isError, false);
  assert.match(retryNotice.payload.message, /app-server 拥塞/);
  assert.equal(retryNotice.payload.code, -32001);
  assert.equal(byType(events, 'status').at(-1).payload.reason, 'backpressure_retry');

  const second = JSON.parse(writes[1]);
  assert.equal(second.method, 'thread/list');
  session.handleLine(JSON.stringify({ id: second.id, result: { threads: [] } }));

  assert.deepEqual(await p, { threads: [] });
  assert.equal(session.pending.size, 0);
});

test('request: app-server -32001 超过退避上限后 reject 并提示拥塞失败', async () => {
  const { session, events } = makeSession();
  const { writes, child } = fakeChild();
  session.child = child;

  const p = session.request('thread/list', {}, {
    maxBackpressureRetries: 1,
    backpressureBaseMs: 1,
  });

  const first = JSON.parse(writes[0]);
  session.handleLine(JSON.stringify({
    id: first.id,
    error: { code: -32001, message: 'Server overloaded; retry later.' },
  }));
  await waitFor(() => writes.length === 2);

  const second = JSON.parse(writes[1]);
  session.handleLine(JSON.stringify({
    id: second.id,
    error: { code: -32001, message: 'Server overloaded; retry later.' },
  }));

  await assert.rejects(p, /Server overloaded/);
  const congestionError = byType(events, 'system').at(-1);
  assert.equal(congestionError.payload.isError, true);
  assert.match(congestionError.payload.message, /超过重试上限/);
  assert.equal(congestionError.payload.code, -32001);
  assert.equal(byType(events, 'status').at(-1).payload.reason, 'backpressure_failed');
});

test('handleLine: 未知 id 的响应被安全忽略', () => {
  const { session, events } = makeSession();
  assert.doesNotThrow(() => session.handleLine(JSON.stringify({ id: 4242, result: {} })));
  assert.equal(events.length, 0);
});

test('notify: 写出无 id 的通知帧', () => {
  const { session } = makeSession();
  const { writes, child } = fakeChild();
  session.child = child;
  session.notify('initialized', { x: 1 });
  const sent = JSON.parse(writes[0]);
  assert.equal(sent.method, 'initialized');
  assert.equal(sent.id, undefined);
  assert.deepEqual(sent.params, { x: 1 });
});

test('onStdout: 跨 chunk 分割的一行被正确重组', () => {
  const { session, events } = makeSession();
  session.onStdout(Buffer.from('{"method":"item/agentMessage/del'));
  assert.equal(events.length, 0); // 半行,暂存不处理
  session.onStdout(Buffer.from('ta","params":{"delta":"Hi"}}\n'));
  const td = byType(events, 'text_delta');
  assert.equal(td.length, 1);
  assert.equal(td[0].payload.text, 'Hi');
});

// ---- ensureReady:新建 vs 恢复 thread ----

test('ensureReady: 无 sessionId → thread/start,记录 sessionId 并回调 onSessionId', async () => {
  let sidCb = null;
  const { session } = makeSession({ onSessionId: id => { sidCb = id; } });
  session.child = fakeChild().child;
  const calls = [];
  session.request = async m => { calls.push(m); return m === 'thread/start' ? { thread: { id: 'thr_new' } } : {}; };
  session.notify = () => {};
  await session.ensureReady();
  assert.ok(calls.includes('initialize'));
  assert.ok(calls.includes('thread/start'));
  assert.ok(!calls.includes('thread/resume'));
  assert.equal(session.sessionId, 'thr_new');
  assert.equal(sidCb, 'thr_new');
});

test('ensureReady: 有 sessionId → thread/resume,不新建', async () => {
  const { session } = makeSession({ resumeId: 'thr_existing' });
  session.child = fakeChild().child;
  const calls = [];
  session.request = async m => { calls.push(m); return {}; };
  session.notify = () => {};
  await session.ensureReady();
  assert.ok(calls.includes('thread/resume'));
  assert.ok(!calls.includes('thread/start'));
  assert.equal(session.sessionId, 'thr_existing');
});

test('ensureReady: 只执行一次(缓存 ready promise)', async () => {
  const { session } = makeSession();
  session.child = fakeChild().child;
  let starts = 0;
  session.request = async m => { if (m === 'thread/start') starts++; return { thread: { id: 't' } }; };
  session.notify = () => {};
  await session.ensureReady();
  await session.ensureReady();
  assert.equal(starts, 1);
});

test('ensureInitialized: 初始化失败后下一次调用会重新尝试', async () => {
  const { session } = makeSession();
  session.child = fakeChild().child;
  let attempts = 0;
  session.request = async method => {
    assert.equal(method, 'initialize');
    attempts++;
    if (attempts === 1) throw new Error('temporary initialize failure');
    return {};
  };
  session.notify = () => {};

  await assert.rejects(session.ensureInitialized(), /temporary initialize failure/);
  await session.ensureInitialized();

  assert.equal(attempts, 2);
});

test('ensureReady: thread 恢复失败后重试且不重复初始化', async () => {
  const { session } = makeSession({ resumeId: 'thr_retry' });
  session.child = fakeChild().child;
  let initializeAttempts = 0;
  let resumeAttempts = 0;
  session.request = async method => {
    if (method === 'initialize') {
      initializeAttempts++;
      return {};
    }
    assert.equal(method, 'thread/resume');
    resumeAttempts++;
    if (resumeAttempts === 1) throw new Error('temporary resume failure');
    return {};
  };
  session.notify = () => {};

  await assert.rejects(session.ensureReady(), /temporary resume failure/);
  await session.ensureReady();

  assert.equal(initializeAttempts, 1);
  assert.equal(resumeAttempts, 2);
});

test('transport error 后下一次 ensureReady 会重新初始化并恢复 thread', async () => {
  const { session } = makeSession({ resumeId: 'thr_after_error' });
  session.child = fakeChild().child;
  const calls = [];
  session.request = async method => {
    calls.push(method);
    return {};
  };
  session.notify = () => {};

  await session.ensureReady();
  session.handleTransportError(new Error('transport failed'));
  await session.ensureReady();

  assert.deepEqual(calls, [
    'initialize',
    'thread/resume',
    'initialize',
    'thread/resume',
  ]);
});

// ---- 输入队列与回合失败 ----

test('enqueueInput: 队列满时拒绝并发系统错误', () => {
  const { session, events } = makeSession();
  session.inputQueueLimit = 2;
  session.inputQueue = [{ text: 'a' }, { text: 'b' }];
  assert.equal(session.enqueueInput('c'), false);
  const sys = byType(events, 'system').at(-1);
  assert.ok(sys.payload.isError);
  assert.match(sys.payload.message, /队列已满/);
});

test('startTurn: turn/start 抛错 → error(recoverable) 且 busy 复位、返回 false', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_x';
  session.child = fakeChild().child;
  session.ensureReady = async () => {};
  session.request = async () => { throw new Error('rpc 挂了'); };
  const r = await session.startTurn('do it');
  assert.equal(r, false);
  assert.equal(session.busy, false);
  const err = byType(events, 'error').at(-1);
  assert.match(err.payload.message, /turn\/start 失败/);
  assert.equal(err.payload.recoverable, true);
});

test('steerTurn: turn/steer 抛错 → recoverable error 且不破坏当前 turn', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_steer_fail';
  session.currentTurnId = 'turn_active';
  session.busy = true;
  session.child = fakeChild().child;
  session.ensureReady = async () => {};
  session.request = async (method) => {
    if (method === 'turn/steer') throw new Error('steer rejected');
    return {};
  };

  const result = await session.send('recover by steering');

  assert.equal(result, false);
  assert.equal(session.busy, true);
  assert.equal(session.currentTurnId, 'turn_active');
  assert.equal(session.inputQueue.length, 0);
  const err = byType(events, 'error').at(-1);
  assert.match(err.payload.message, /turn\/steer 失败/);
  assert.match(err.payload.message, /steer rejected/);
  assert.equal(err.payload.recoverable, true);
});

test('startTurn: 带附件 → 结构化 mention 且 user_message 只含元数据(无 absPath)', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_att';
  session.child = fakeChild().child;
  session.ensureReady = async () => {};
  let sentInput = null;
  session.request = async (m, p) => { if (m === 'turn/start') sentInput = p.input; return {}; };
  await session.startTurn('读文件', [{ kind: 'file', name: 'a.txt', mimeType: 'text/plain', size: 10, absPath: '/w/.ccm-uploads/a.txt' }]);
  assert.deepEqual(sentInput, [
    { type: 'text', text: '读文件', text_elements: [] },
    { type: 'mention', name: 'a.txt', path: '/w/.ccm-uploads/a.txt' },
  ]);
  const um = byType(events, 'user_message').at(-1);
  assert.equal(um.payload.text, '读文件');
  assert.deepEqual(um.payload.attachments, [{ name: 'a.txt', mimeType: 'text/plain', size: 10 }]); // 不含 absPath
});

test('scheduleDrain: 重复调用只排一次', async () => {
  const { session } = makeSession();
  let drains = 0;
  session.drainQueue = async () => { drains++; };
  session.scheduleDrain();
  session.scheduleDrain(); // 第二次应被 drainScheduled 短路
  await new Promise(r => setTimeout(r, 10));
  assert.equal(drains, 1);
});

test('scheduleDrain: drainQueue 抛错 → error(queue_error)', async () => {
  const { session, events } = makeSession();
  session.drainQueue = async () => { throw new Error('drain 崩了'); };
  session.scheduleDrain();
  await new Promise(r => setTimeout(r, 10));
  const err = byType(events, 'error').at(-1);
  assert.ok(err, '应 emit error');
  assert.match(err.payload.message, /队列继续执行失败/);
});

// ---- 通知与 item 的边界分支 ----

test('turn/failed: 顶层 error.message 兜底', () => {
  const { session, events } = makeSession();
  session.handleNotification('turn/failed', { error: { message: '顶层失败' } });
  assert.match(byType(events, 'error').at(-1).payload.message, /顶层失败/);
});

test('turn/failed: 无任何错误信息 → 默认「任务失败」', () => {
  const { session, events } = makeSession();
  session.handleNotification('turn/failed', {});
  assert.match(byType(events, 'error').at(-1).payload.message, /任务失败/);
});

test('handleCommandOutputDelta: 空输出不发事件', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/commandExecution/outputDelta', { itemId: 'c1', delta: '' });
  assert.equal(byType(events, 'tool_output_delta').length, 0);
});

test('handleCommandOutputDelta: text/output 兜底 + stream 默认 stdout', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/commandExecution/outputDelta', { toolUseId: 'c2', text: 'from-text' });
  const td = byType(events, 'tool_output_delta').at(-1);
  assert.equal(td.payload.toolUseId, 'c2');
  assert.equal(td.payload.text, 'from-text');
  assert.equal(td.payload.stream, 'stdout');
});

test('item/completed(fileChange): kind 为字符串或缺失时归一', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'fileChange', id: 'f2', status: 'completed', changes: [
    { path: '/w/s.txt', kind: 'delete', diff: '' }, // 字符串 kind
    { path: '/w/m.txt', diff: '' },                 // 缺失 kind
  ] } });
  const fc = byType(events, 'file_change').at(-1);
  assert.equal(fc.payload.files[0].kind, 'delete');
  assert.equal(fc.payload.files[1].kind, 'modify');
});

test('item/started(mcpToolCall): arguments 为字符串时原样截断', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/started', { item: { type: 'mcpToolCall', id: 'm3', serverName: 's', toolName: 't', arguments: 'raw-string-args' } });
  assert.match(byType(events, 'mcp_use').at(-1).payload.inputSummary, /raw-string-args/);
});

// ---- 中断/回应/清理的边界 ----

test('abort: 无子进程时不发 turn/interrupt,但仍复位状态并清队列', () => {
  const { session, events } = makeSession();
  session.child = null;
  session.busy = true;
  session.inputQueue = [{ text: 'q' }];
  session.abort();
  assert.equal(session.busy, false);
  assert.equal(byType(events, 'status').at(-1).payload.reason, 'interrupt_cleared_queue');
});

test('abort: 有进程但无排队输入时状态为 interrupt', () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_a';
  session.notify = () => {};
  session.child = fakeChild().child;
  session.busy = true;
  session.abort();
  assert.equal(byType(events, 'status').at(-1).payload.reason, 'interrupt');
});

test('respond: 无子进程时静默返回(不抛错)', () => {
  const { session } = makeSession();
  session.child = null;
  assert.doesNotThrow(() => session.respond(1, {}));
});

test('respondApproval: 缺省 decision 时回 decline', () => {
  const { session } = makeSession();
  const { writes, child } = fakeChild();
  session.child = child;
  session.pendingApprovals.add(3);
  assert.equal(session.respondApproval(3), true);
  assert.deepEqual(JSON.parse(writes[0]).result, { decision: 'decline' });
});

test('dispose: reject 所有在途请求且 child.kill 抛错被吞掉', async () => {
  const { session } = makeSession();
  session.child = { stdin: { write() {} }, kill: () => { throw new Error('kill failed'); }, on() {} };
  const p = new Promise((res, rej) => session.pending.set(1, { resolve: res, reject: rej }));
  assert.doesNotThrow(() => session.dispose());
  assert.equal(session.disposed, true);
  assert.equal(session.child, null);
  await assert.rejects(p, /disposed/);
});

// ---- 进程生命周期(真实子进程,确定性触发)----

test('spawnIfNeeded: 启动失败(ENOENT)→ emit error(不可恢复)', async () => {
  const events = [];
  let seen;
  const errored = new Promise(res => { seen = res; });
  const session = new ThreadRuntime({
    instanceId: 'enoent', cwd: '/tmp', codexBin: '/nonexistent/codex-xxx', idleTimeoutMs: 600000,
    onEvent: e => { events.push(e); if (e.type === 'error') seen(); },
    onSessionId() {}, onExit() {},
  });
  session.spawnIfNeeded();
  await Promise.race([errored, new Promise(r => setTimeout(r, 1500))]);
  const err = events.find(e => e.type === 'error' && /启动失败/.test(e.payload.message));
  assert.ok(err, '应 emit 启动失败 error');
  assert.equal(err.payload.recoverable, false);
  session.dispose();
});

test('spawnIfNeeded: 子进程退出 → busy 复位、child 置空、onExit 触发、清理 idleTimer', async () => {
  let resolveExit;
  const exited = new Promise(res => { resolveExit = res; });
  const { session } = makeSession({ codexBin: 'true', onExit: () => resolveExit() });
  session.busy = true;
  session.spawnIfNeeded();
  await Promise.race([exited, new Promise(r => setTimeout(r, 1500))]);
  assert.equal(session.busy, false);
  assert.equal(session.child, null);
  assert.equal(session.idleTimer, null);
});

test('transport termination clears the stale turn before any restart input can steer it', () => {
  const exited = makeSession().session;
  exited.busy = true;
  exited.currentTurnId = 'turn_before_exit';
  exited.handleTransportExit();
  assert.equal(exited.currentTurnId, null);

  const errored = makeSession().session;
  errored.busy = true;
  errored.currentTurnId = 'turn_before_error';
  errored.handleTransportError(new Error('transport failed'));
  assert.equal(errored.currentTurnId, null);
});

// ---- 协议字段缺省时的降级(对上游省略可选字段的鲁棒性)----

test('审批请求缺少可选字段 → command/cwd/reason 为 null,decisions 用默认', () => {
  const { session, events } = makeSession();
  session.handleLine(JSON.stringify({ method: 'item/commandExecution/requestApproval', id: 1 })); // 无 params
  const ar = byType(events, 'approval_request')[0];
  assert.equal(ar.payload.command, null);
  assert.equal(ar.payload.cwd, null);
  assert.equal(ar.payload.reason, null);
  assert.deepEqual(ar.payload.availableDecisions, ['accept', 'decline']);
});

test('通知缺少 params → 不崩溃、不误发', () => {
  const { session, events } = makeSession();
  assert.doesNotThrow(() => session.handleLine(JSON.stringify({ method: 'item/agentMessage/delta' })));
  assert.equal(byType(events, 'text_delta').length, 0);
});

test('响应 error 无 message → 以 JSON 字符串 reject', async () => {
  const { session } = makeSession();
  const { writes, child } = fakeChild();
  session.child = child;
  const p = session.request('x', {});
  const id = JSON.parse(writes[0]).id;
  session.handleLine(JSON.stringify({ id, error: { code: -32000 } }));
  await assert.rejects(p, /-32000/);
});

test('tokenUsage 无 .last → 直接用 tokenUsage', () => {
  const { session, events } = makeSession();
  session.handleNotification('thread/tokenUsage/updated', { tokenUsage: { totalTokens: 42 } });
  assert.deepEqual(byType(events, 'usage').at(-1).payload.usage, { totalTokens: 42 });
  assert.deepEqual(session.tokenUsage, { totalTokens: 42 });
});

test('plan 缺失 → 空数组', () => {
  const { session, events } = makeSession();
  session.handleNotification('turn/plan/updated', { explanation: 'x' });
  assert.deepEqual(byType(events, 'plan').at(-1).payload.plan, []);
});

test('outputDelta: output 字段兜底 + item.id 兜底;全空则早退', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/commandExecution/outputDelta', { item: { id: 'ci' }, output: 'via-output' });
  const td = byType(events, 'tool_output_delta').at(-1);
  assert.equal(td.payload.text, 'via-output');
  assert.equal(td.payload.toolUseId, 'ci');
  const before = events.length;
  session.handleNotification('item/commandExecution/outputDelta', {}); // 无 delta/text/output
  assert.equal(events.length, before);
});

test('outputDelta: 无任何 id → toolUseId 为 null', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/commandExecution/outputDelta', { text: 'x' });
  assert.equal(byType(events, 'tool_output_delta').at(-1).payload.toolUseId, null);
});

test('handleItem: item 无 type → 忽略', () => {
  const { session, events } = makeSession();
  assert.doesNotThrow(() => session.handleNotification('item/started', { item: { id: 'x' } }));
  assert.equal(events.length, 0);
});

test('commandExecution: 缺 command/status → 空命令 + 默认 completed', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/started', { item: { type: 'commandExecution', id: 'c' } });
  assert.equal(byType(events, 'tool_use').at(-1).payload.inputSummary, '');
  session.handleNotification('item/completed', { item: { type: 'commandExecution', id: 'c', exitCode: 0 } });
  assert.equal(byType(events, 'tool_result').at(-1).payload.status, 'completed');
});

test('commandExecution: 超长输出被截断', () => {
  const { session, events } = makeSession();
  const big = 'x'.repeat(700);
  session.handleNotification('item/completed', { item: { type: 'commandExecution', id: 'c', exitCode: 0, aggregatedOutput: big } });
  const sum = byType(events, 'tool_result').at(-1).payload.outputSummary;
  assert.ok(sum.length < big.length);
  assert.match(sum, /已截断/);
});

test('fileChange: 缺 changes → 空文件列表', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'fileChange', id: 'f', status: 'completed' } });
  assert.deepEqual(byType(events, 'file_change').at(-1).payload.files, []);
});

test('mcpToolCall: 缺 server/tool/arguments → unknown + {}', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/started', { item: { type: 'mcpToolCall', id: 'm' } });
  const mu = byType(events, 'mcp_use').at(-1);
  assert.equal(mu.payload.serverName, 'unknown');
  assert.equal(mu.payload.toolName, 'unknown');
  assert.equal(mu.payload.inputSummary, '{}');
});

test('mcp_result: 无 error 无 result → 空摘要;非字符串 result → 空', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'mcpToolCall', id: 'm1' } });
  assert.equal(byType(events, 'mcp_result').at(-1).payload.outputSummary, '');
  session.handleNotification('item/completed', { item: { type: 'mcpToolCall', id: 'm2', result: 12345 } });
  assert.equal(byType(events, 'mcp_result').at(-1).payload.outputSummary, '');
});

test('webSearch: 缺 results → 空;结果缺 snippet → 空串', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'webSearch', id: 'w', query: 'q', results: [{ title: 't', url: 'u' }] } });
  assert.equal(byType(events, 'search').at(-1).payload.results[0].snippet, '');
  session.handleNotification('item/completed', { item: { type: 'webSearch', id: 'w2', query: 'q2' } });
  assert.deepEqual(byType(events, 'search').at(-1).payload.results, []);
});

test('startTurn: 抛非 Error 值 → String(err) 兜底', async () => {
  const { session, events } = makeSession();
  session.sessionId = 't';
  session.child = fakeChild().child;
  session.ensureReady = async () => {};
  session.request = async () => { throw 'plain-string-error'; };
  assert.equal(await session.startTurn('x'), false);
  assert.match(byType(events, 'error').at(-1).payload.message, /plain-string-error/);
});

test('scheduleDrain: 抛非 Error 值 → String(err) 兜底', async () => {
  const { session, events } = makeSession();
  session.drainQueue = async () => { throw 'drain-plain'; };
  session.scheduleDrain();
  await new Promise(r => setTimeout(r, 10));
  assert.match(byType(events, 'error').at(-1).payload.message, /drain-plain/);
});

test('abort: notify 抛错被吞掉,状态仍复位', () => {
  const { session } = makeSession();
  session.sessionId = 't';
  session.busy = true;
  session.child = fakeChild().child;
  session.notify = () => { throw new Error('write fail'); };
  assert.doesNotThrow(() => session.abort());
  assert.equal(session.busy, false);
});

test('ensureReady: thread/start 返回 threadId(无 thread.id)也能记录', async () => {
  const { session } = makeSession();
  session.child = fakeChild().child;
  session.request = async m => (m === 'thread/start' ? { threadId: 'thr_alt' } : {});
  session.notify = () => {};
  await session.ensureReady();
  assert.equal(session.sessionId, 'thr_alt');
});

test('ensureReady: thread/start 无 id → sessionId 保持 null,不回调', async () => {
  let cb = 0;
  const { session } = makeSession({ onSessionId: () => { cb++; } });
  session.child = fakeChild().child;
  session.request = async () => ({});
  session.notify = () => {};
  await session.ensureReady();
  assert.equal(session.sessionId, null);
  assert.equal(cb, 0);
});

test('eventsSince: 空 buffer 不崩溃', () => {
  const { session } = makeSession();
  const r = session.eventsSince(0);
  assert.deepEqual(r.events, []);
  assert.equal(r.gap, false);
});

test('emitStatus: disposed 后不再发状态', () => {
  const { session, events } = makeSession();
  session.disposed = true;
  session.emitStatus('x');
  assert.equal(byType(events, 'status').length, 0);
});

test('numberFromEnv: 合法环境变量覆盖默认队列上限;非法值回退默认', () => {
  const prev = process.env.CODEX_INPUT_QUEUE_LIMIT;
  try {
    process.env.CODEX_INPUT_QUEUE_LIMIT = '5';
    assert.equal(makeSession().session.inputQueueLimit, 5);
    process.env.CODEX_INPUT_QUEUE_LIMIT = '0'; // 0 不合法
    assert.equal(makeSession().session.inputQueueLimit, 20);
  } finally {
    if (prev === undefined) delete process.env.CODEX_INPUT_QUEUE_LIMIT;
    else process.env.CODEX_INPUT_QUEUE_LIMIT = prev;
  }
});

test('LOG_STDERR: 开启时 ensureReady 记录日志(不影响会话结果)', async () => {
  const prev = process.env.LOG_STDERR;
  const origErr = console.error;
  process.env.LOG_STDERR = '1';
  console.error = () => {}; // 静音日志输出
  try {
    const s1 = makeSession({ resumeId: 'thr_r' }).session; // resume 路径
    s1.child = fakeChild().child;
    s1.request = async () => ({}); s1.notify = () => {};
    await s1.ensureReady();
    const s2 = makeSession().session; // start 路径
    s2.child = fakeChild().child;
    s2.request = async m => (m === 'thread/start' ? { thread: { id: 't' } } : {}); s2.notify = () => {};
    await s2.ensureReady();
    assert.equal(s1.sessionId, 'thr_r');
    assert.equal(s2.sessionId, 't');
  } finally {
    console.error = origErr;
    if (prev === undefined) delete process.env.LOG_STDERR;
    else process.env.LOG_STDERR = prev;
  }
});

// ---- rpc 日志的体积与开关 ----

test('rpc observability: rotates instead of growing without bound', () => {
  // 日志此前没有任何上限：本仓库根目录的 .codex-chat-rpc.jsonl 已累积 4.4MB / 10928 行，
  // 其中 7609 行（70%）来自流式 delta——每个 token 增量一行。delta 现已不落盘，所以这里
  // 改用会留档的通知来制造体积；轮转本身仍必须有上限。
  const dir = mkdtempSync(join(tmpdir(), 'ccm-rpc-rotate-'));
  const rpcLogPath = join(dir, 'rpc-rotate.jsonl');
  try {
    const { session } = makeSession({ cwd: dir, rpcLogPath, rpcLogMaxBytes: 8 * 1024 });
    const { child } = fakeChild();
    session.child = child;

    for (let index = 0; index < 400; index += 1) {
      session.handleLine(JSON.stringify({
        method: 'item/completed',
        params: { threadId: 'thr_1', turnId: 'turn_1', item: { type: 'agentMessage', id: `item_${index}`, text: `chunk-${index}` } },
      }));
    }

    assert.deepEqual(readdirSync(dir).sort(), ['rpc-rotate.jsonl', 'rpc-rotate.jsonl.1']);
    assert.ok(
      statSync(rpcLogPath).size <= 8 * 1024,
      `轮转后当前文件应回到上限内，实际 ${statSync(rpcLogPath).size}`,
    );
    assert.equal(statSync(rpcLogPath).mode & 0o777, 0o600, '轮转后新文件仍须 owner-only');
    assert.equal(statSync(`${rpcLogPath}.1`).mode & 0o777, 0o600, '轮转出去的文件同样须 owner-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rpc observability: CODEX_RPC_LOG=0 turns the log off entirely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-rpc-off-'));
  const previous = process.env.CODEX_RPC_LOG;
  process.env.CODEX_RPC_LOG = '0';
  try {
    const { session } = makeSession({ cwd: dir });
    const { child } = fakeChild();
    session.child = child;
    session.handleLine(JSON.stringify({ method: 'thread/compacted', params: { threadId: 'thr_1' } }));
    assert.deepEqual(readdirSync(dir), [], '关掉观测时不应在工作区落任何文件');
  } finally {
    if (previous === undefined) delete process.env.CODEX_RPC_LOG;
    else process.env.CODEX_RPC_LOG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rpc observability: redacts a private key longer than any scan window', () => {
  // 曾经给脱敏加过一个 1920 字符的扫描窗口，理由是「输出反正只截到 240，窗口外的
  // 内容都会被丢掉，所以不改变输出」。那是错的：PEM 这类模式需要匹配到结束标记，
  // 把 END 切掉整条 pattern 就失配，于是 240 字符的密钥材料明文落盘。
  const dir = mkdtempSync(join(tmpdir(), 'ccm-rpc-pem-'));
  const rpcLogPath = join(dir, 'rpc-pem.jsonl');
  try {
    const { session } = makeSession({ cwd: dir, rpcLogPath });
    const { child } = fakeChild();
    session.child = child;

    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${'MIIJKQIBAAKCAgEA'.repeat(200)}\n-----END RSA PRIVATE KEY-----`;
    session.handleLine(JSON.stringify({
      method: 'thread/compacted',
      params: { threadId: 'thr_1', reason: `failed to load key: ${pem}` },
    }));

    const raw = readFileSync(rpcLogPath, 'utf8');
    assert.doesNotMatch(raw, /BEGIN RSA PRIVATE KEY/, '私钥块不应出现在日志里');
    assert.doesNotMatch(raw, /MIIJKQIBAAKCAgEA/, '私钥材料不应出现在日志里');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rpc observability: recreates a deleted log with owner-only permissions', () => {
  // Codex agent 在自己的 cwd 里有 shell（rm、git clean -xfd），日志文件可能在运行中
  // 消失。裸 appendFileSync 会按 umask 默认模式重建，把 RPC 流量暴露给同机其他用户。
  const dir = mkdtempSync(join(tmpdir(), 'ccm-rpc-remode-'));
  const rpcLogPath = join(dir, 'rpc-remode.jsonl');
  try {
    const { session } = makeSession({ cwd: dir, rpcLogPath });
    session.appendRpcLog({ frame: 'first' });
    assert.equal(statSync(rpcLogPath).mode & 0o777, 0o600);

    unlinkSync(rpcLogPath);
    session.appendRpcLog({ frame: 'after delete' });
    assert.equal(statSync(rpcLogPath).mode & 0o777, 0o600, '重建的日志仍须 owner-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rpc observability: rotation survives another runtime sharing the same log', () => {
  // rpcLogPath 默认是 join(cwd, '.codex-chat-rpc.jsonl')，而 server.js 的 createAgent
  // 从不传它——同一个 cwd 上的多个 runtime 共写一个文件，却各持一个字节计数器。
  // 谁的计数先到上限谁就轮转，rmSync(path.1) 顺手删掉别人刚存下的那一代。
  const dir = mkdtempSync(join(tmpdir(), 'ccm-rpc-shared-'));
  const rpcLogPath = join(dir, 'shared.jsonl');
  try {
    const first = makeSession({ cwd: dir, rpcLogPath, rpcLogMaxBytes: 4096 }).session;
    const second = makeSession({ cwd: dir, rpcLogPath, rpcLogMaxBytes: 4096 }).session;
    for (let index = 0; index < 300; index += 1) {
      (index % 2 === 0 ? first : second).appendRpcLog({ frame: 'x'.repeat(40), index });
    }

    const countLines = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).length;
    const retained = countLines(rpcLogPath) + countLines(`${rpcLogPath}.1`);
    assert.ok(retained > 40, `共享日志时轮转互相踩踏，两代加起来只剩 ${retained} 行`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rpc observability: a failing rotation does not silence the log forever', () => {
  // 轮转抛错（.1 被占用、只读挂载）时异常被 appendRpcLog 的空 catch 吞掉，而文件
  // 仍然超限——下一帧再次尝试轮转、再次抛错，日志就此永久静默。旧实现每帧独立
  // append，单次失败下一帧就恢复了。
  const dir = mkdtempSync(join(tmpdir(), 'ccm-rpc-rotfail-'));
  const rpcLogPath = join(dir, 'rotfail.jsonl');
  try {
    const { session } = makeSession({ cwd: dir, rpcLogPath, rpcLogMaxBytes: 512 });
    session.rotateRpcLog = () => { throw new Error('rotation failed'); };

    for (let index = 0; index < 40; index += 1) {
      session.appendRpcLog({ frame: 'x'.repeat(40), index });
    }

    const lines = readFileSync(rpcLogPath, 'utf8').trim().split('\n').filter(Boolean).length;
    assert.ok(lines > 20, `轮转失败后日志被永久静默，只写进 ${lines} 行`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rpc observability: refuses to write through a symlinked log path', () => {
  // uploads.js 对上传目录做了 symlink 守卫，rpc 日志没有——openSync 少了 O_NOFOLLOW，
  // 会顺着链接写穿到目标文件，还把目标 chmod 成 600。
  const dir = mkdtempSync(join(tmpdir(), 'ccm-rpc-symlink-'));
  const target = join(dir, 'innocent.txt');
  const linked = join(dir, 'rpc-linked.jsonl');
  try {
    writeFileSync(target, 'original contents\n');
    symlinkSync(target, linked);

    const { session } = makeSession({ cwd: dir, rpcLogPath: linked });
    session.appendRpcLog({ frame: 'should not land' });

    assert.equal(readFileSync(target, 'utf8'), 'original contents\n', '不应写穿符号链接');
    assert.equal(session.rpcLogPath, null, '遇到符号链接应停用日志而不是每帧重试');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// RPC 日志是可观测数据，不是安全审计（文件里自陈如此）。delta 帧的正文早已被打码成
// `<redacted:N chars>` 占位符，诊断价值接近零，却占了本机 8 MB 日志的 96%——真正有用的
// request/response/error 被挤出保留窗口。按帧类型过滤，统计仍然照记。
test('rpc 日志跳过已打码的 delta 通知，保留 request/response/error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-rpc-delta-'));
  const rpcLogPath = join(dir, 'rpc-delta.jsonl');
  try {
    const { session } = makeSession({ cwd: dir, rpcLogPath });
    const before = session.rpcStats.serverNotifications;

    for (const method of ['item/agentMessage/delta', 'item/reasoning/delta', 'item/commandExecution/outputDelta']) {
      session.observeRpc('notification', { direction: 'inbound', method, params: { delta: 'x'.repeat(500) } });
    }
    session.observeRpc('notification', { direction: 'inbound', method: 'turn/completed', params: {} });

    const methods = readJsonl(rpcLogPath).map(entry => entry.method);
    assert.deepEqual(methods, ['turn/completed'], '只有非 delta 通知落盘');
    assert.equal(session.rpcStats.serverNotifications, before + 4, '统计仍要覆盖全部通知');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- observeTransportFrame：host 模式下的帧分类与 turn 追踪 ----
//
// 这条路径在 host 模式（多 runtime 共用一个 app-server 子进程）下是**唯一**的观测入口，
// 而它此前只被间接碰到：`:277`/`:283`/`:288`–`:295` 共 15 个变异全部存活。

test('observeTransportFrame 把四类帧分开记，方向与 id 都是判据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-observe-classify-'));
  const rpcLogPath = join(dir, 'rpc.jsonl');
  try {
    const { session } = makeSession({ cwd: dir, rpcLogPath });

    // 服务端请求：有 method、有 id、方向是 inbound。三个条件缺一就不是它。
    session.observeTransportFrame({
      direction: 'inbound',
      frame: { id: 7, method: 'item/commandExecution/requestApproval', params: {} },
    });
    // 客户端请求：同样有 method 有 id，但方向是 outbound。
    session.observeTransportFrame({
      direction: 'outbound',
      frame: { id: 8, method: 'turn/start', params: {} },
    });
    // 通知：有 method、没有 id。
    session.observeTransportFrame({
      direction: 'inbound',
      frame: { method: 'turn/started', params: {} },
    });
    // 响应：有 id、没有 method。
    session.observeTransportFrame({
      direction: 'inbound',
      frame: { id: 9, result: { ok: true } },
    });

    assert.deepEqual(readJsonl(rpcLogPath).map(line => line.frame),
      ['server_request', 'request', 'notification', 'response'],
      '分类错的后果是 RPC 日志谎报流量方向——排查时唯一的线索就成了误导');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 方法名优先取调用方传进来的那个：响应帧本身不带 method，只有发起时的上下文知道它是什么。
// 回落顺序写反的话，响应那一行的 method 会变成 null，日志里请求与响应就配不成对。
test('observeTransportFrame 的方法名优先用调用方给的，其次才看帧里的', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-observe-method-'));
  const rpcLogPath = join(dir, 'rpc.jsonl');
  try {
    const { session } = makeSession({ cwd: dir, rpcLogPath });

    // 响应帧没有 method，靠调用方补。
    session.observeTransportFrame({ direction: 'inbound', method: 'thread/list', frame: { id: 1, result: {} } });
    // 帧自带 method、调用方没给。
    session.observeTransportFrame({ direction: 'inbound', frame: { method: 'turn/started', params: {} } });
    // 两个都没有：记 null，而不是 undefined 或崩溃。
    session.observeTransportFrame({ direction: 'inbound', frame: { id: 2, result: {} } });

    assert.deepEqual(readJsonl(rpcLogPath).map(line => line.method),
      ['thread/list', 'turn/started', null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// currentTurnId 是 steer / abort / 中断的目标。记错了，用户点「停止」停的是别的轮次。
test('只有 turn/start 与 turn/steer 的入站响应会记录当前轮次', () => {
  const accepted = [
    ['turn/start 的响应', 'turn/start', { turn: { id: 'turn-a' } }, 'turn-a'],
    ['turn/steer 的响应', 'turn/steer', { turn: { id: 'turn-b' } }, 'turn-b'],
    ['结果用 turnId 而不是 turn.id', 'turn/start', { turnId: 'turn-c' }, 'turn-c'],
  ];
  for (const [label, method, result, expected] of accepted) {
    const { session } = makeSession();
    session.observeTransportFrame({ direction: 'inbound', method, frame: { id: 1, result } });
    assert.equal(session.currentTurnId, expected, label);
  }

  const ignored = [
    ['出站的 turn/start（那是请求，还没有结果）', 'outbound', 'turn/start', { turn: { id: 'nope' } }],
    ['别的方法的入站响应', 'inbound', 'thread/start', { turn: { id: 'nope' } }],
    ['入站通知（没有 result）', 'inbound', 'turn/started', undefined],
  ];
  for (const [label, direction, method, result] of ignored) {
    const { session } = makeSession();
    session.observeTransportFrame({ direction, method, frame: { id: 1, result } });
    assert.equal(session.currentTurnId, null, label);
  }
});

// 服务端请求（审批等）带 turnId 时可以用它补上当前轮次——但**只在还不知道的时候**。
// 覆盖已知值的后果：一个无关请求把 currentTurnId 改掉，之后的 steer / abort 打错目标。
test('服务端请求携带的 turnId 只在当前轮次未知时被采纳', () => {
  {
    const { session } = makeSession();
    assert.equal(session.currentTurnId, null, '前置：一开始不知道');
    session.handleServerRequest(1, 'item/commandExecution/requestApproval', { turnId: 'turn-from-request' });
    assert.equal(session.currentTurnId, 'turn-from-request', '不知道时可以从服务端请求里补');
  }
  {
    const { session } = makeSession();
    session.currentTurnId = 'turn-known';
    session.handleServerRequest(1, 'item/commandExecution/requestApproval', { turnId: 'turn-other' });
    assert.equal(session.currentTurnId, 'turn-known',
      '已经知道当前轮次时不许被覆盖——覆盖了之后 steer / abort 就打在别的轮次上');
  }
  for (const bad of ['', 123, null, undefined]) {
    const { session } = makeSession();
    session.handleServerRequest(1, 'item/commandExecution/requestApproval', { turnId: bad });
    assert.equal(session.currentTurnId, null, `turnId=${String(bad)} 不是可用的轮次标识`);
  }
});

// ---- 旧版审批方法的参数归一 ----
//
// applyPatchApproval / execCommandApproval 是旧协议的审批方法，它们不带
// threadId / turnId / itemId。归一化补上这三个字段——而它们**正是手机按下「同意」时
// 用来核对目标的那三个**（见 approval-broker 的 approvalTargetMatches）。
// 补错了的后果：手机的应答对不上，审批静默失效；或者对上了别的请求，
// agent 拿到一个用户从没看过的授权。这个函数有 12 个变异存活。
test('旧版审批方法补齐的目标字段能被手机的应答对上', () => {
  const { session } = makeSession();
  session.sessionId = 'thr_current';

  session.handleServerRequest(77, 'execCommandApproval', { callId: 'call_1', command: ['ls'] });

  // 用补出来的三个字段应答：必须对得上。
  assert.equal(session.approvalBroker.respondApproval(77, 'accept', {
    threadId: 'thr_current',       // 没给 threadId / conversationId → 回落到当前会话
    turnId: 'legacy_turn_77',      // 没给 turnId 且当前轮次未知 → 用 rpcId 造一个
    itemId: 'call_1',              // 没给 itemId → 回落到 callId
  }), true, '补出来的三个字段必须与手机看到的一致');
});

test('旧版审批的三个字段各自的回落顺序', () => {
  const cases = [
    ['threadId 优先用自己的', { threadId: 'thr_own', conversationId: 'thr_conv' }, 'threadId', 'thr_own'],
    ['其次用 conversationId', { conversationId: 'thr_conv' }, 'threadId', 'thr_conv'],
    ['最后回落到当前会话', {}, 'threadId', 'thr_current'],
    ['itemId 优先', { itemId: 'item_1', callId: 'call_1', approvalId: 'appr_1' }, 'itemId', 'item_1'],
    ['其次 callId', { callId: 'call_1', approvalId: 'appr_1' }, 'itemId', 'call_1'],
    ['再次 approvalId', { approvalId: 'appr_1' }, 'itemId', 'appr_1'],
    ['都没有则按 rpcId 造一个', {}, 'itemId', 'legacy_request_88'],
    ['turnId 优先用自己的', { turnId: 'turn_own' }, 'turnId', 'turn_own'],
    ['都没有则按 rpcId 造一个', {}, 'turnId', 'legacy_turn_88'],
  ];

  for (const [label, params, field, expected] of cases) {
    const { session } = makeSession();
    session.sessionId = 'thr_current';
    session.handleServerRequest(88, 'applyPatchApproval', params);
    // 用期望值去应答：对得上说明归一化补的就是它。
    assert.equal(session.approvalBroker.respondApproval(88, 'accept', { [field]: expected }), true, label);
  }

  // 空串不算「给了」，要继续往下回落。
  const { session } = makeSession();
  session.sessionId = 'thr_current';
  session.handleServerRequest(88, 'applyPatchApproval', { threadId: '', itemId: '', callId: 'call_x' });
  assert.equal(session.approvalBroker.respondApproval(88, 'accept', {
    threadId: 'thr_current', itemId: 'call_x',
  }), true, '空串要跳过，不能当成有效值补上去');
});

// turnId 已知时用已知的那个，而不是造一个——造出来的 legacy_turn_N 与真实轮次对不上，
// 手机上那条审批就挂在一个不存在的轮次下面。
test('当前轮次已知时旧版审批沿用它，不另造一个', () => {
  const { session } = makeSession();
  session.sessionId = 'thr_current';
  session.currentTurnId = 'turn_real';
  session.handleServerRequest(99, 'execCommandApproval', { callId: 'c' });
  assert.equal(session.approvalBroker.respondApproval(99, 'accept', { turnId: 'turn_real' }), true);
});

// 非旧版方法不该被动手脚：新协议自己带齐了这三个字段，凭空补字段会覆盖掉真值。
test('非旧版方法的参数原样透传，不被归一化改写', () => {
  const { session } = makeSession();
  session.sessionId = 'thr_current';
  session.handleServerRequest(11, 'item/commandExecution/requestApproval', {
    threadId: 'thr_real', turnId: 'turn_real', itemId: 'item_real',
  });
  assert.equal(session.approvalBroker.respondApproval(11, 'accept', {
    threadId: 'thr_real', turnId: 'turn_real', itemId: 'item_real',
  }), true, '新协议自带的三个字段必须原样保留');
});

// ---- RPC 统计计数器 ----
//
// 七个计数器各自认一组 (frame, direction)。串了的后果是 statusPayload 里的诊断数字
// 说谎——排查「客户端发了多少请求 / 服务端推了多少通知」时，那是唯一的量化线索。
// 这个函数有 14 个变异存活。
test('七个 RPC 计数器各认各的帧类型与方向，不互相串', () => {
  const { session } = makeSession();
  const combos = [
    ['request', 'outbound', 'clientRequests'],
    ['response', 'inbound', 'clientResponses'],
    ['response', 'outbound', 'serverResponses'],
    ['notification', 'outbound', 'clientNotifications'],
    ['notification', 'inbound', 'serverNotifications'],
    ['server_request', 'inbound', 'serverRequests'],
  ];

  for (const [frame, direction, counter] of combos) {
    const before = { ...session.rpcStats };
    session.incrementRpcStats(frame, { direction });
    for (const [key, value] of Object.entries(session.rpcStats)) {
      const expected = key === counter ? before[key] + 1 : before[key];
      assert.equal(value, expected,
        `${frame}/${direction} 应当只加 ${counter}，实际动了 ${key}`);
    }
  }

  // 反方向的组合一个都不该加：出站的 request 是我们发的，入站的 request 是服务端请求，
  // 两者算在不同的桶里。
  const before = { ...session.rpcStats };
  session.incrementRpcStats('request', { direction: 'inbound' });
  assert.deepEqual(session.rpcStats, before, '入站的 request 不属于任何一个客户端计数器');

  // server_request 不看方向——它按定义只会是入站的。
  const beforeServerRequest = session.rpcStats.serverRequests;
  session.incrementRpcStats('server_request', {});
  assert.equal(session.rpcStats.serverRequests, beforeServerRequest + 1);
});

test('带 error 的帧额外计一次错误，与它属于哪个桶无关', () => {
  const { session } = makeSession();
  const before = { ...session.rpcStats };
  session.incrementRpcStats('response', { direction: 'inbound', error: { code: -1 } });
  assert.equal(session.rpcStats.errors, before.errors + 1, '错误单独计数');
  assert.equal(session.rpcStats.clientResponses, before.clientResponses + 1,
    '同时它仍然是一条入站响应——两个计数器都要动');

  const afterFirst = { ...session.rpcStats };
  session.incrementRpcStats('response', { direction: 'inbound' });
  assert.equal(session.rpcStats.errors, afterFirst.errors, '没有 error 就不加错误计数');
});

// ---- 构造时的安全策略默认值 ----
//
// approvalPolicy 与 sandbox 是**发给 codex 的安全策略**。回落写错的后果是这两个字段
// 变成 undefined 送上去，由 codex 自己挑一个默认——而它的默认未必和本项目的一致。
// 这两行加上 experimentalApi 的严格判定，共 7 个变异存活。
test('审批策略与沙箱有明确的默认值，环境变量为空时不会漏成 undefined', () => {
  const saved = { policy: process.env.CODEX_APPROVAL_POLICY, sandbox: process.env.CODEX_SANDBOX };
  try {
    delete process.env.CODEX_APPROVAL_POLICY;
    delete process.env.CODEX_SANDBOX;
    const { session } = makeSession();
    assert.equal(session.approvalPolicy, 'on-request', '默认要人确认，而不是交给上游挑');
    assert.equal(session.sandbox, 'workspace-write', '默认限制在工作区内');

    process.env.CODEX_APPROVAL_POLICY = '';
    process.env.CODEX_SANDBOX = '';
    const { session: empty } = makeSession();
    assert.equal(empty.approvalPolicy, 'on-request', '空串等同于没设，不能当成有效策略');
    assert.equal(empty.sandbox, 'workspace-write');

    process.env.CODEX_APPROVAL_POLICY = 'never';
    process.env.CODEX_SANDBOX = 'read-only';
    const { session: custom } = makeSession();
    assert.equal(custom.approvalPolicy, 'never', '显式配置要生效');
    assert.equal(custom.sandbox, 'read-only');
  } finally {
    for (const [key, value] of [['CODEX_APPROVAL_POLICY', saved.policy], ['CODEX_SANDBOX', saved.sandbox]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('实验 API 默认关闭且只认严格 true；RPC 日志上限拒绝非法值', () => {
  assert.equal(makeSession().session.experimentalApi, false, '不传时默认关闭');
  assert.equal(makeSession({ experimentalApi: true }).session.experimentalApi, true);
  for (const bad of [1, 'true', {}, null]) {
    assert.equal(makeSession({ experimentalApi: bad }).session.experimentalApi, false,
      `experimentalApi=${String(bad)} 不是严格 true，不该开启`);
  }

  const fallback = makeSession().session.rpcLogMaxBytes;
  assert.ok(Number.isInteger(fallback) && fallback > 0, '默认上限必须是个正整数');
  for (const bad of [0, -1, 1.5, Number.NaN, '1024', null]) {
    assert.equal(makeSession({ rpcLogMaxBytes: bad }).session.rpcLogMaxBytes, fallback,
      `rpcLogMaxBytes=${String(bad)} 必须回落——0 会让每条记录都"超限"，日志从此一条也写不进去`);
  }
  assert.equal(makeSession({ rpcLogMaxBytes: 2048 }).session.rpcLogMaxBytes, 2048);
});

// ---- turn 覆盖参数要真的送到 codex ----
//
// 用户在 composer 里选的模型与服务档位靠这两行送上去。漏掉的表现是**静默降级**：
// 界面显示选的是 gpt-5，实际跑的是账号默认模型，而没有任何提示。
// thread/start 与 thread/resume 两条路径各有一份，是「形态漏过整族」的又一例。
test('turn 覆盖的模型与服务档位在 thread/start 与 thread/resume 上都送出去', async () => {
  for (const [label, resumeId, method] of [
    ['新建线程', null, 'thread/start'],
    ['恢复线程', 'thr_existing', 'thread/resume'],
  ]) {
    const { session } = makeSession({ resumeId });
    const { writes, child } = fakeChild();
    session.child = child;
    session.initialized = true;
    if (resumeId) session.sessionId = resumeId;
    session.turnOverrides = { model: 'gpt-5-codex', serviceTier: 'priority' };

    session.ensureReady().catch(() => {});
    await new Promise(resolve => setImmediate(resolve));

    const sent = writes.map(chunk => JSON.parse(chunk)).find(frame => frame.method === method);
    assert.ok(sent, `${label}：应当发出 ${method}`);
    assert.equal(sent.params.model, 'gpt-5-codex', `${label}：模型覆盖必须送到 codex`);
    assert.equal(sent.params.serviceTier, 'priority', `${label}：服务档位覆盖同理`);
    assert.equal(sent.params.approvalPolicy, session.approvalPolicy, `${label}：安全策略一并送出`);
    assert.equal(sent.params.sandbox, session.sandbox);
  }
});

test('没有 turn 覆盖时不凭空塞 model / serviceTier 字段', async () => {
  const { session } = makeSession();
  const { writes, child } = fakeChild();
  session.child = child;
  session.initialized = true;
  session.turnOverrides = {};

  session.ensureReady().catch(() => {});
  await new Promise(resolve => setImmediate(resolve));

  const sent = writes.map(chunk => JSON.parse(chunk)).find(frame => frame.method === 'thread/start');
  assert.equal('model' in sent.params, false, '没选就不该出现——凭空塞会覆盖账号默认');
  assert.equal('serviceTier' in sent.params, false);
});

// ---- 终端输出增量 ----
test('终端输出的正文与进程标识各有回落链', () => {
  const encoded = Buffer.from('已解码正文', 'utf8').toString('base64');
  const cases = [
    ['优先用 base64 正文', { deltaBase64: encoded, delta: 'x', text: 'y' }, '已解码正文'],
    ['其次用 delta', { delta: '来自 delta' }, '来自 delta'],
    ['再次用 text', { text: '来自 text' }, '来自 text'],
  ];
  for (const [label, params, expected] of cases) {
    const { session, events } = makeSession();
    session.handleNotification('process/outputDelta', { processHandle: 'ph', ...params });
    assert.equal(byType(events, 'term_output').slice(-1)[0].payload.text, expected, label);
  }

  // 三处都没有正文时不发事件——一条空的终端输出只会让卡片抖一下。
  const { session, events } = makeSession();
  session.handleNotification('process/outputDelta', { processHandle: 'ph' });
  assert.deepEqual(byType(events, 'term_output'), [], '没有正文就不该发事件');
});

test('终端输出的进程标识优先用该通知自己那种键名', () => {
  // process/outputDelta 用 processHandle，terminal/outputDelta 用 processId。
  const { session, events } = makeSession();
  session.handleNotification('process/outputDelta',
    { processHandle: 'ph_1', processId: 'pid_1', delta: 'x' });
  assert.equal(byType(events, 'term_output').slice(-1)[0].payload.processId, 'ph_1',
    '这条通知的主键是 processHandle，两个都有时以它为准');

  const other = makeSession();
  other.session.handleNotification('process/outputDelta', { processId: 'pid_only', delta: 'x' });
  assert.equal(byType(other.events, 'term_output').slice(-1)[0].payload.processId, 'pid_only',
    '主键缺失时回落到另一种写法');

  const none = makeSession();
  none.session.handleNotification('process/outputDelta', { delta: 'x' });
  assert.equal(byType(none.events, 'term_output').slice(-1)[0].payload.processId, null);
  assert.equal(byType(none.events, 'term_output').slice(-1)[0].payload.stream, 'stdout', '流默认 stdout');
});

// ---- 推理正文的提取 ----
test('推理正文从 summary 或 content 里提取，三种片段写法都认', () => {
  const cases = [
    ['summary 优先于 content', { summary: ['来自 summary'], content: ['来自 content'] }, '来自 summary'],
    ['summary 为空时用 content', { summary: [], content: ['来自 content'] }, '来自 content'],
    ['片段是裸字符串', { summary: ['a', 'b'] }, 'a\nb'],
    ['片段是 { text }', { summary: [{ text: 'a' }, { text: 'b' }] }, 'a\nb'],
    ['片段是 { content }', { summary: [{ content: 'a' }] }, 'a'],
    ['混着来', { summary: ['a', { text: 'b' }, { content: 'c' }] }, 'a\nb\nc'],
    ['认不出的片段被丢掉，不产生空行', { summary: ['a', { nope: 1 }, 'b'] }, 'a\nb'],
  ];
  for (const [label, item, expected] of cases) {
    const { session, events } = makeSession();
    session.handleItem({ type: 'reasoning', id: 'r1', ...item }, true);
    assert.equal(byType(events, 'reasoning').slice(-1)[0].payload.text, expected, label);
  }

  // 提取不出正文时不发事件——一张空的推理卡片对用户没有意义。
  for (const item of [{}, { summary: [] }, { summary: [{ nope: 1 }] }, { summary: '不是数组' }]) {
    const { session, events } = makeSession();
    session.handleItem({ type: 'reasoning', id: 'r1', ...item }, true);
    assert.deepEqual(byType(events, 'reasoning'), [], `${JSON.stringify(item)} 提不出正文就不发`);
  }
});
