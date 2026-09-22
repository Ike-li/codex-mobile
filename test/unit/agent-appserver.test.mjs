// test/unit/agent-appserver.test.mjs —— ThreadRuntime 对 app-server JSON-RPC 通知的映射契约。
// 真实通知形状（已探针采样 / 官方 README）：
//   item/agentMessage/delta  {threadId,turnId,itemId,delta}
//   item/started|completed    {item:{type,id,...}, threadId, turnId}
//     agentMessage:     {type:"agentMessage", id, text}
//     commandExecution: {type:"commandExecution", id, command, aggregatedOutput, exitCode, status}
//   turn/completed   {threadId, turn:{id, status:"completed"}}
//   turn/failed      {threadId, turn:{error:{message}}}
//   thread/tokenUsage/updated  {threadId, turnId, tokenUsage:{last:{...}}}
//   turn/diff/updated  {threadId, turnId, diff}
// Items now covered: agentMessage / commandExecution / fileChange / mcpToolCall / webSearch / reasoning
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadRuntime } from '../../src/agent/agent-appserver.js';

function makeSession(overrides = {}) {
  const events = [];
  const session = new ThreadRuntime({
    instanceId: 'inst_test',
    resumeId: null,
    cwd: '/tmp/work',
    // 不能写字面量 'codex'：那要靠宿主机 PATH 解析，缺失时进程会静默消失（没有 TAP
    // 输出、没有 not ok，只剩一份没有汇总行的日志）。CI 的 Node 22 腿正是这样死的——
    // 它跳过了 Install pinned Codex。用 process.execPath：绝对路径、必然存在、不走 PATH。
    // 这些用例本来也不执行它，只是需要它可解析。
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

test('item/agentMessage/delta: 流式 → 多条 text_delta', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/agentMessage/delta', { delta: 'P' });
  session.handleNotification('item/agentMessage/delta', { delta: 'ONG' });
  const td = byType(events, 'text_delta');
  assert.equal(td.length, 2);
  assert.equal(td.map(e => e.payload.text).join(''), 'PONG');
});

test('item/completed(agentMessage): 不重复发正文（已由 delta 给出）', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'PONG' } });
  assert.equal(byType(events, 'text_delta').length, 0);
});

test('item userMessage from app-server is not shown as a raw card', () => {
  const { session, events } = makeSession();
  const item = {
    type: 'userMessage',
    id: 'u1',
    clientId: 'req-1',
    content: [{ type: 'text', text: 'Reply with just the word PONG.', text_elements: [] }],
  };
  session.handleNotification('item/started', { item });
  session.handleNotification('item/completed', { item: { ...item, status: 'completed' } });
  assert.equal(byType(events, 'raw_item').length, 0);
  assert.equal(byType(events, 'user_message').length, 0);
});

test('item/started(commandExecution): → tool_use', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/started', { item: { type: 'commandExecution', id: 'c1', command: "ls -a", aggregatedOutput: '', exitCode: null, status: 'in_progress' } });
  const tu = byType(events, 'tool_use')[0];
  assert.ok(tu);
  assert.equal(tu.payload.toolUseId, 'c1');
  assert.match(tu.payload.inputSummary, /ls -a/);
});

test('item/completed(commandExecution): → tool_result', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'ls', aggregatedOutput: 'a\nb\n', exitCode: 0, status: 'completed' } });
  const tr = byType(events, 'tool_result')[0];
  assert.ok(tr);
  assert.equal(tr.payload.ok, true);
  assert.equal(tr.payload.exitCode, 0);
  assert.equal(tr.payload.status, 'completed');
  assert.match(tr.payload.outputSummary, /a\nb/);
});

test('turn/completed: → result 且 busy 置为 false', () => {
  const { session, events } = makeSession();
  session.busy = true;
  session.handleNotification('turn/completed', { turn: { id: 't1', status: 'completed' } });
  assert.ok(byType(events, 'result')[0]);
  assert.equal(session.busy, false);
});

test('abort during thread/start prevents the pending turn/start', async () => {
  const { session, events } = makeSession();
  const methods = [];
  let releaseReady;
  const readyGate = new Promise(resolve => { releaseReady = resolve; });
  session.ensureReady = async () => readyGate;
  session.request = async method => {
    methods.push(method);
    return { turn: { id: 't-late', status: 'inProgress' } };
  };

  const sending = session.startTurn('keep listing primes');
  await session.abort();
  releaseReady();
  assert.equal(await sending, false);
  assert.ok(!methods.includes('turn/start'));
  assert.equal(session.busy, false);
  assert.equal(session.currentTurnId, null);
  assert.ok(byType(events, 'system').some(event => /中断/.test(event.payload.message)));
});

test('abort while turn/start is in flight interrupts the orphaned turn', async () => {
  // 姊妹用例 'abort during thread/start …' 守的是 ensureReady() 期间的窗口。
  // 这一条守它之后的窗口：turn/start 已经发出、响应尚未回来时用户点停止。
  // 此刻 currentTurnId 还是 null，abort() 发不出 turn/interrupt；若返回后不补发，
  // 这个 turn 会在 app-server 上继续跑，且再也没有任何路径能中断它。
  const { session, events } = makeSession();
  session.sessionId = 'thr-orphan';
  session.child = {};
  session.ensureReady = async () => {};
  const calls = [];
  let releaseTurnStart;
  session.request = async (method, params) => {
    calls.push({ method, params });
    if (method !== 'turn/start') return {};
    return new Promise(resolve => { releaseTurnStart = () => resolve({ turn: { id: 'turn-orphan' } }); });
  };

  const dispatched = session.dispatchUserMessage({ text: 'rm -rf /tmp/x', clientRequestId: 'req-orphan' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(call => call.method === 'turn/start'), 'turn/start 应已在途');

  await session.abort();
  assert.equal(session.currentTurnId, null);
  assert.ok(!calls.some(call => call.method === 'turn/interrupt'), 'abort 当时还不知道 turnId');

  releaseTurnStart();
  const outcome = await dispatched;

  const interrupt = calls.find(call => call.method === 'turn/interrupt');
  assert.ok(interrupt, 'turn/start 返回后必须补发 turn/interrupt');
  assert.equal(interrupt.params.turnId, 'turn-orphan');
  assert.equal(interrupt.params.threadId, 'thr-orphan');

  assert.equal(outcome.accepted, false);
  assert.equal(outcome.state, 'rejected');
  assert.equal(outcome.reason, 'interrupted');
  assert.equal(session.currentTurnId, null, '被撤销的 turn 不应进入 currentTurnId');

  // 与既有的 interrupted 分支保持一致：不把被撤销的 turn 记成已提交。
  assert.equal(byType(events, 'status').some(event => event.payload.reason === 'turn_submitted'), false);
});

test('turn completed before turn/start continuation does not resurrect its turn id or submitted status', async () => {
  const { session, events } = makeSession();
  session.ensureReady = async () => {};
  session.sessionId = 'thr-fast';
  session.request = async method => {
    assert.equal(method, 'turn/start');
    const response = { turn: { id: 'turn-fast', status: 'inProgress' } };
    session.observeTransportFrame({ direction: 'inbound', method, frame: { result: response } });
    session.handleNotification('turn/completed', {
      threadId: 'thr-fast',
      turn: { id: 'turn-fast', status: 'completed' },
    });
    return response;
  };

  assert.equal(await session.startTurn('fast completion'), true);
  assert.equal(session.busy, false);
  assert.equal(session.currentTurnId, null);
  assert.equal(byType(events, 'status').some(event => event.payload.reason === 'turn_submitted'), false);
});

test('dispatchUserMessage returns a submitted outcome and maps clientRequestId to clientUserMessageId', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr-submit';
  session.ensureReady = async () => {};
  let request;
  session.request = async (method, params) => {
    request = { method, params };
    return { turn: { id: 'turn-submit', status: 'inProgress' } };
  };

  const outcome = await session.dispatchUserMessage({
    text: 'submit once',
    clientRequestId: 'req-submit',
  });

  assert.deepEqual(outcome, {
    accepted: true,
    state: 'submitted',
    clientRequestId: 'req-submit',
    threadId: 'thr-submit',
    turnId: 'turn-submit',
  });
  assert.deepEqual(request, {
    method: 'turn/start',
    params: {
      threadId: 'thr-submit',
      clientUserMessageId: 'req-submit',
      cwd: '/tmp/work',
      input: [{ type: 'text', text: 'submit once', text_elements: [] }],
    },
  });
  assert.equal(byType(events, 'user_message')[0].payload.clientRequestId, 'req-submit');
});

// steer 是往正在跑的 turn 里追加输入，那一轮的权限/模型早已生效，所以 steerTurnDispatch
// 不接收 turn 参数、overrides 被整个丢掉——这在语义上是对的，不该改。
//
// 但此前它是**静默**丢弃：用户在 turn 快结束时改了权限再发一句，设置没生效、界面上
// 也没有任何痕迹，只能等下一轮自己发现。e2e/session-settings.spec.js 那个长期 flaky
// 就是同一个机制的另一面（测试没等 turn 真正结束，于是落进了 steer 分支）。
test('steer 丢弃 turn overrides 时给出可见提示，而不是静默吞掉', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr-steer';
  session.currentTurnId = 'turn-running';
  session.busy = true;
  session.request = async () => ({ turn: { id: 'turn-running', status: 'inProgress' } });

  const outcome = await session.dispatchUserMessage({
    text: '顺便看看这个',
    clientRequestId: 'req-steer',
    turn: { permission: { mode: 'host' } },
  });

  assert.equal(outcome.state, 'steered', '前置：busy + currentTurnId 必须走 steer');
  const notice = byType(events, 'system').find(event => /下一轮/.test(event.payload?.message || ''));
  assert.ok(notice, 'steer 丢掉了 turn overrides，必须告诉用户它们没生效');
  assert.equal(notice.payload.isError, false, '这不是错误，是一次说明');
});

test('steer 不带 overrides 时不产生多余提示', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr-steer-plain';
  session.currentTurnId = 'turn-running';
  session.busy = true;
  session.request = async () => ({ turn: { id: 'turn-running', status: 'inProgress' } });

  await session.dispatchUserMessage({ text: '继续', clientRequestId: 'req-plain', turn: {} });

  assert.deepEqual(
    byType(events, 'system').filter(event => /下一轮/.test(event.payload?.message || '')),
    [],
    '没带设置就不该提示——否则每次追加输入都弹一条噪音',
  );
});

test('dispatchUserMessage forwards CLI model, effort, approval and sandbox onto turn/start', async () => {
  const { session } = makeSession();
  session.sessionId = 'thr-cli-settings';
  session.ensureReady = async () => {};
  let request;
  session.request = async (method, params) => {
    request = { method, params };
    return { turn: { id: 'turn-cli-settings', status: 'inProgress' } };
  };

  const outcome = await session.dispatchUserMessage({
    text: 'use these settings',
    clientRequestId: 'req-cli-settings',
    turn: {
      model: 'gpt-5.6-sol',
      effort: 'max',
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      serviceTier: 'fast',
    },
  });

  assert.equal(outcome.accepted, true);
  assert.equal(request.method, 'turn/start');
  assert.equal(request.params.model, 'gpt-5.6-sol');
  assert.equal(request.params.effort, 'max');
  assert.equal(request.params.approvalPolicy, 'untrusted');
  assert.equal(request.params.serviceTier, 'fast');
  assert.deepEqual(request.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(session.approvalPolicy, 'untrusted');
  assert.equal(session.sandbox, 'read-only');
});

test('dispatchUserMessage accepts an attachment-only mention without injecting a path into text', async () => {
  const { session } = makeSession();
  session.sessionId = 'thr-attachment-only';
  session.ensureReady = async () => {};
  let request;
  session.request = async (method, params) => {
    request = { method, params };
    return { turn: { id: 'turn-attachment-only', status: 'inProgress' } };
  };

  const outcome = await session.dispatchUserMessage({
    text: '',
    savedAttachments: [{
      kind: 'file',
      absPath: '/tmp/work/.ccm-uploads/report.txt',
      name: 'report.txt',
      mimeType: 'text/plain',
      size: 12,
    }],
    clientRequestId: 'req-attachment-only',
  });

  assert.equal(outcome.accepted, true);
  assert.deepEqual(request.params.input, [{
    type: 'mention',
    name: 'report.txt',
    path: '/tmp/work/.ccm-uploads/report.txt',
  }]);
});

test('dispatchUserMessage redacts structured part paths from the user_message event', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr-part-event';
  session.ensureReady = async () => {};
  session.request = async () => ({ turn: { id: 'turn-part-event', status: 'inProgress' } });

  await session.dispatchUserMessage({
    text: '',
    parts: [{ kind: 'mention', name: 'src/server.js', path: '/tmp/work/src/server.js' }],
    clientRequestId: 'req-part-event',
  });

  assert.deepEqual(byType(events, 'user_message')[0].payload.parts, [{
    kind: 'mention',
    name: 'src/server.js',
  }]);
});

test('dispatchUserMessage returns a steered outcome with the same client message id', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr-steer-id';
  session.busy = true;
  session.currentTurnId = 'turn-active';
  session.ensureReady = async () => {};
  let request;
  session.request = async (method, params) => {
    request = { method, params };
    return { turnId: 'turn-active' };
  };

  const outcome = await session.dispatchUserMessage({
    text: 'adjust once',
    clientRequestId: 'req-steer',
  });

  assert.deepEqual(outcome, {
    accepted: true,
    state: 'steered',
    clientRequestId: 'req-steer',
    threadId: 'thr-steer-id',
    turnId: 'turn-active',
  });
  assert.deepEqual(request, {
    method: 'turn/steer',
    params: {
      threadId: 'thr-steer-id',
      clientUserMessageId: 'req-steer',
      input: [{ type: 'text', text: 'adjust once', text_elements: [] }],
      expectedTurnId: 'turn-active',
    },
  });
  assert.equal(byType(events, 'user_message')[0].payload.clientRequestId, 'req-steer');
});

test('dispatchUserMessage preserves clientRequestId through queued and dequeued submission', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr-queue-id';
  session.busy = true;
  session.currentTurnId = null;
  session.ensureReady = async () => {};
  let request;
  session.request = async (method, params) => {
    request = { method, params };
    return { turn: { id: 'turn-queued', status: 'inProgress' } };
  };

  const outcome = await session.dispatchUserMessage({
    text: 'queue once',
    clientRequestId: 'req-queued-runtime',
  });

  assert.equal(outcome.accepted, true);
  assert.equal(outcome.state, 'queued');
  assert.equal(outcome.clientRequestId, 'req-queued-runtime');
  assert.equal(outcome.threadId, 'thr-queue-id');
  assert.equal(outcome.position, 1);
  assert.equal(typeof outcome.queuedAt, 'number');
  assert.equal(session.inputQueue[0].clientRequestId, 'req-queued-runtime');
  assert.equal(byType(events, 'queued_message')[0].payload.clientRequestId, 'req-queued-runtime');

  session.busy = false;
  await session.drainQueue();

  assert.equal(byType(events, 'dequeued_message')[0].payload.clientRequestId, 'req-queued-runtime');
  assert.equal(byType(events, 'user_message')[0].payload.clientRequestId, 'req-queued-runtime');
  assert.equal(request.method, 'turn/start');
  assert.equal(request.params.clientUserMessageId, 'req-queued-runtime');
  assert.deepEqual(byType(events, 'message_receipt').at(-1).payload, {
    clientRequestId: 'req-queued-runtime',
    state: 'submitted',
    threadId: 'thr-queue-id',
    turnId: 'turn-queued',
  });
});

test('queued message emits a rejected receipt when turn/start fails after dequeue', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr-queue-failure';
  session.busy = true;
  session.currentTurnId = null;
  session.ensureReady = async () => {};
  session.request = async method => {
    assert.equal(method, 'turn/start');
    throw new Error('mock turn/start failure');
  };

  const queued = await session.dispatchUserMessage({
    text: 'fail after dequeue',
    clientRequestId: 'req-queue-failure',
  });
  assert.equal(queued.state, 'queued');

  session.busy = false;
  assert.equal(await session.drainQueue(), false);

  const receipts = byType(events, 'message_receipt');
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].payload, {
    clientRequestId: 'req-queue-failure',
    state: 'rejected',
    threadId: 'thr-queue-failure',
    turnId: null,
    errorCode: 'turn_start_failed',
  });
});

test('turn/failed: → error', () => {
  const { session, events } = makeSession();
  session.handleNotification('turn/failed', { turn: { error: { message: 'boom' } } });
  assert.match(byType(events, 'error')[0].payload.message, /boom/);
});

test('thread/tokenUsage/updated: → usage', () => {
  const { session, events } = makeSession();
  session.handleNotification('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 10 } } });
  assert.deepEqual(byType(events, 'usage')[0].payload.usage, { totalTokens: 10 });
});

// modelContextWindow 只在完整的 tokenUsage 上，不在 .last 里。状态栏要算
// 「还剩多少上下文」就必须拿到它——只留 .last 等于把分母丢了。
test('thread/tokenUsage/updated: 保留 modelContextWindow 给状态栏', () => {
  const { session, events } = makeSession();
  session.handleNotification('thread/tokenUsage/updated', {
    tokenUsage: {
      last: { totalTokens: 82491 },
      total: { totalTokens: 250000 },
      modelContextWindow: 272000,
    },
  });
  assert.equal(session.tokenUsage.modelContextWindow, 272000);
  assert.equal(session.tokenUsage.last.totalTokens, 82491);
  assert.equal(byType(events, 'usage').at(-1).payload.tokenUsage.modelContextWindow, 272000);
});

test('未接管的通知被安全忽略', () => {
  const { session, events } = makeSession();
  for (const m of ['mcpServer/unknown']) {
    assert.doesNotThrow(() => session.handleNotification(m, {}));
  }
  assert.equal(events.length, 0);
});

test('thread/status/changed becomes the runtime activity source', () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr-status';

  session.handleNotification('thread/status/changed', {
    threadId: 'thr-status',
    status: { type: 'active', activeFlags: [] },
  });

  assert.equal(session.busy, true);
  assert.deepEqual(session.statusPayload('thread-status').threadStatus, {
    type: 'active', activeFlags: [],
  });
  assert.deepEqual(byType(events, 'thread_status')[0].payload, {
    threadId: 'thr-status',
    status: { type: 'active', activeFlags: [] },
  });
});

test('handleLine: server→client 审批请求 → approval_request + 记录 pending', () => {
  const { session, events } = makeSession();
  session.handleLine(JSON.stringify({
    method: 'item/commandExecution/requestApproval', id: 7,
    params: { threadId: 't', turnId: 'u', itemId: 'c', command: 'echo hi > f.txt', cwd: '/w', reason: 'retry without sandbox?', availableDecisions: ['accept', 'cancel'] },
  }));
  const ar = byType(events, 'approval_request')[0];
  assert.ok(ar, '应 emit approval_request');
  assert.equal(ar.payload.approvalId, 7);
  assert.match(ar.payload.command, /echo hi/);
  assert.equal(ar.payload.cwd, '/w');
  assert.ok(session.pendingApprovals.has(7));
});

test('respondApproval: 写出 JSON-RPC 响应 {id,result:{decision}} 并清除 pending', () => {
  const { session } = makeSession();
  const writes = [];
  session.child = { stdin: { write: s => writes.push(s) } };
  session.pendingApprovals.add(7);
  assert.equal(session.respondApproval(7, 'accept'), true);
  assert.equal(session.pendingApprovals.has(7), false);
  const sent = JSON.parse(writes[0]);
  assert.equal(sent.id, 7);
  assert.deepEqual(sent.result, { decision: 'accept' });
});

test('respondApproval: 未知 id 返回 false', () => {
  const { session } = makeSession();
  session.child = { stdin: { write: () => {} } };
  assert.equal(session.respondApproval(999, 'accept'), false);
});

test('未知 server 请求被安全兜底回应（不挂起 agent）', () => {
  const { session } = makeSession();
  const writes = [];
  session.child = { stdin: { write: s => writes.push(s) } };
  session.handleLine(JSON.stringify({ method: 'some/unknownRequest', id: 5, params: {} }));
  const sent = JSON.parse(writes[0]);
  assert.equal(sent.id, 5);
  assert.deepEqual(sent.error, {
    code: -32601,
    message: 'Unsupported server request: some/unknownRequest'
  });
});

test('item/completed(fileChange): → file_change（文件列表 + kind + diff）', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: '/w/a.txt', kind: { type: 'add' }, diff: 'aaa\n' }, { path: '/w/b.txt', kind: { type: 'modify' }, diff: '-x\n+y\n' }] } });
  const fc = byType(events, 'file_change')[0];
  assert.ok(fc, '应 emit file_change');
  assert.equal(fc.payload.files.length, 2);
  assert.equal(fc.payload.files[0].path, '/w/a.txt');
  assert.equal(fc.payload.files[0].kind, 'add');
  assert.equal(fc.payload.files[1].kind, 'modify');
});

test('turn/plan/updated: → plan', () => {
  const { session, events } = makeSession();
  session.handleNotification('turn/plan/updated', { plan: [{ step: 'do x', status: 'pending' }, { step: 'do y', status: 'completed' }] });
  const p = byType(events, 'plan')[0];
  assert.ok(p, '应 emit plan');
  assert.equal(p.payload.plan.length, 2);
  assert.equal(p.payload.plan[0].step, 'do x');
});

test('item/reasoning/summaryTextDelta: → reasoning', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/reasoning/summaryTextDelta', { delta: 'thinking…' });
  const reasoning = byType(events, 'reasoning')[0].payload;
  assert.equal(reasoning.text, 'thinking…');
  assert.equal(reasoning.channel, 'summary');
  assert.equal(reasoning.kind, 'summary_text_delta');
});

test('reasoning full stream notifications map to reasoning envelopes', () => {
  const { session, events } = makeSession();

  session.handleNotification('item/reasoning/textDelta', {
    threadId: 'thr_reason',
    turnId: 'turn_reason',
    itemId: 'item_reason',
    contentIndex: 0,
    delta: 'full thought',
  });
  session.handleNotification('item/reasoning/summaryPartAdded', {
    threadId: 'thr_reason',
    turnId: 'turn_reason',
    itemId: 'item_reason',
    summaryIndex: 1,
  });

  const [full, part] = byType(events, 'reasoning').map(e => e.payload);
  assert.deepEqual(full, {
    text: 'full thought',
    channel: 'full',
    kind: 'text_delta',
    threadId: 'thr_reason',
    turnId: 'turn_reason',
    itemId: 'item_reason',
    contentIndex: 0,
  });
  assert.deepEqual(part, {
    text: '',
    channel: 'summary',
    kind: 'summary_part_added',
    threadId: 'thr_reason',
    turnId: 'turn_reason',
    itemId: 'item_reason',
    summaryIndex: 1,
  });
});

test('item/started(mcpToolCall): → mcp_use', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/started', { item: { type: 'mcpToolCall', id: 'mcp1', serverName: 'github', toolName: 'search_repos', arguments: { q: 'codex' } } });
  const mu = byType(events, 'mcp_use')[0];
  assert.ok(mu, '应 emit mcp_use');
  assert.equal(mu.payload.toolUseId, 'mcp1');
  assert.equal(mu.payload.serverName, 'github');
  assert.equal(mu.payload.toolName, 'search_repos');
  assert.match(mu.payload.inputSummary, /codex/);
});

test('item/completed(mcpToolCall): → mcp_result', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'mcpToolCall', id: 'mcp1', serverName: 'github', toolName: 'search_repos', result: '[{"name":"codex"}]' } });
  const mr = byType(events, 'mcp_result')[0];
  assert.ok(mr, '应 emit mcp_result');
  assert.equal(mr.payload.toolUseId, 'mcp1');
  assert.equal(mr.payload.ok, true);
  assert.match(mr.payload.outputSummary, /codex/);
});

test('item/completed(mcpToolCall with error): → mcp_result ok=false', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'mcpToolCall', id: 'mcp2', serverName: 'github', toolName: 'bad', error: { message: 'timeout' } } });
  const mr = byType(events, 'mcp_result')[0];
  assert.equal(mr.payload.ok, false);
  assert.match(mr.payload.outputSummary, /timeout/);
});

test('item/completed(webSearch): → search', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'webSearch', id: 'ws1', query: 'codex cli', results: [{ title: 'Codex CLI', url: 'https://example.com', snippet: 'The official CLI' }] } });
  const se = byType(events, 'search')[0];
  assert.ok(se, '应 emit search');
  assert.equal(se.payload.query, 'codex cli');
  assert.equal(se.payload.results.length, 1);
  assert.equal(se.payload.results[0].title, 'Codex CLI');
});

test('turn/diff/updated: → diff', () => {
  const { session, events } = makeSession();
  session.handleNotification('turn/diff/updated', { diff: '-old\n+new' });
  const df = byType(events, 'diff')[0];
  assert.ok(df, '应 emit diff');
  assert.match(df.payload.diff, /\+new/);
});

test('send: busy turn queues mobile input and drains FIFO after completion', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_test';
  session.ensureReady = async () => {};
  const started = [];
  session.request = async (method, params) => {
    if (method === 'turn/start') started.push(params.input[0].text);
    return {};
  };

  assert.equal(await session.send('first task'), true);
  assert.equal(await session.send('/diff'), true);
  assert.equal(await session.send('second task'), true);

  assert.deepEqual(started, ['first task']);
  assert.deepEqual(byType(events, 'queued_message').map(e => e.payload.text), ['/diff', 'second task']);
  assert.equal(byType(events, 'queued_message').at(-1).payload.queueLength, 2);

  session.handleNotification('turn/completed', { turn: { id: 't1', status: 'completed' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['first task', '/diff']);

  session.handleNotification('turn/completed', { turn: { id: 't2', status: 'completed' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['first task', '/diff', 'second task']);
});

test('send: busy turn with active currentTurnId steers instead of queueing', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_steer';
  session.ensureReady = async () => {};
  const requests = [];
  session.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'turn/start') return { turn: { id: 'turn_active', status: 'inProgress' } };
    if (method === 'turn/steer') return { turnId: 'turn_active' };
    return {};
  };

  assert.equal(await session.send('first task'), true);
  assert.equal(await session.send('please adjust course'), true);

  assert.deepEqual(requests.map(r => r.method), ['turn/start', 'turn/steer']);
  assert.deepEqual(requests[1].params, {
    threadId: 'thr_steer',
    input: [{ type: 'text', text: 'please adjust course', text_elements: [] }],
    expectedTurnId: 'turn_active',
  });
  assert.equal(session.inputQueue.length, 0);
  assert.equal(byType(events, 'queued_message').length, 0);
  assert.equal(byType(events, 'status').at(-1).payload.reason, 'steer_submitted');
});

test('status: exposes busy queue approval and sandbox state', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_status';
  session.ensureReady = async () => {};
  session.request = async () => ({});

  await session.send('run tests');
  await session.send('/status');
  session.handleServerRequest(42, 'item/commandExecution/requestApproval', {
    command: 'npm test',
    cwd: '/tmp/work',
    reason: 'needs execution',
    availableDecisions: ['accept', 'decline'],
  });

  const status = byType(events, 'status').at(-1).payload;
  assert.equal(status.state, 'awaiting_approval');
  assert.equal(status.busy, true);
  assert.equal(status.queueLength, 1);
  assert.equal(status.pendingApprovals, 1);
  assert.equal(status.approvalPolicy, session.approvalPolicy);
  assert.equal(status.sandbox, session.sandbox);
});

test('abort: interrupts active turn and clears queued phone input', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_abort';
  session.ensureReady = async () => {};
  const requests = [];
  session.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'turn/start') return { turn: { id: 'turn_abort', status: 'inProgress' } };
    return {};
  };
  session.child = { stdin: { write: () => {} } };

  await session.send('long task');
  session.enqueueInput('queued after long task');
  await session.abort();

  assert.deepEqual(requests.at(-1), {
    method: 'turn/interrupt',
    params: { threadId: 'thr_abort', turnId: 'turn_abort' }
  });
  assert.equal(session.busy, false);
  assert.equal(session.inputQueue.length, 0);
  assert.equal(byType(events, 'queue_cleared').at(-1).payload.dropped, 1);
});

test('abort rejects each durable queued message before the aggregate queue-cleared event', async () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_abort_receipts';
  session.busy = true;
  session.currentTurnId = null;

  await session.dispatchUserMessage({
    text: 'durable queued message',
    clientRequestId: 'req-abort-queued',
  });
  session.enqueueInput('legacy queued message');
  await session.abort();

  const receipts = byType(events, 'message_receipt');
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].payload, {
    clientRequestId: 'req-abort-queued',
    state: 'rejected',
    threadId: 'thr_abort_receipts',
    turnId: null,
    errorCode: 'queue_cleared',
    reason: 'interrupt',
  });
  const receiptIndex = events.indexOf(receipts[0]);
  const clearedIndex = events.indexOf(byType(events, 'queue_cleared')[0]);
  assert.ok(receiptIndex < clearedIndex);
});

test('forkThread: sends thread/fork with stable protocol fields', async () => {
  const { session } = makeSession();
  session.sessionId = 'thr_source';
  session.ensureReady = async () => {};
  let forkRequest = null;
  session.request = async (method, params) => {
    if (method === 'thread/fork') {
      forkRequest = params;
      return { thread: { id: 'thr_forked' } };
    }
    return {};
  };

  const response = await session.forkThread({ ephemeral: true });

  assert.deepEqual(forkRequest, {
    threadId: 'thr_source',
    cwd: '/tmp/work',
    approvalPolicy: session.approvalPolicy,
    sandbox: session.sandbox,
    ephemeral: true,
  });
  assert.equal(response.thread.id, 'thr_forked');
});

test('startChatgptDeviceLogin: requests chatgptDeviceCode without starting a thread', async () => {
  const { session, events } = makeSession();
  const calls = [];
  session.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'account/login/start') {
      return {
        type: 'chatgptDeviceCode',
        loginId: 'login_1',
        verificationUrl: 'https://openai.com/device',
        userCode: 'ABCD-EFGH',
      };
    }
    return {};
  };
  session.notify = method => calls.push({ method, params: null });

  const response = await session.startChatgptDeviceLogin();

  assert.equal(response.loginId, 'login_1');
  assert.deepEqual(calls.map(c => c.method), ['initialize', 'initialized', 'account/login/start']);
  assert.deepEqual(calls.at(-1).params, { type: 'chatgptDeviceCode' });
  const login = byType(events, 'account_login').at(-1);
  assert.equal(login.payload.status, 'pending');
  assert.equal(login.payload.userCode, 'ABCD-EFGH');
  assert.equal(login.payload.verificationUrl, 'https://openai.com/device');
});

test('account login and update notifications map to frontend envelopes', () => {
  const { session, events } = makeSession();

  session.handleNotification('account/login/completed', {
    loginId: 'login_1',
    success: true,
    error: null,
  });
  session.handleNotification('account/updated', {
    authMode: 'chatgpt',
    planType: 'plus',
  });

  const login = byType(events, 'account_login').at(-1);
  assert.equal(login.payload.status, 'completed');
  assert.equal(login.payload.loginId, 'login_1');
  assert.equal(login.payload.success, true);

  const account = byType(events, 'account_updated').at(-1);
  assert.deepEqual(account.payload, { authMode: 'chatgpt', planType: 'plus' });

  session.handleNotification('account/login/completed', {
    loginId: 'login_2',
    success: false,
    error: 'expired',
  });
  const failed = byType(events, 'account_login').at(-1);
  assert.equal(failed.payload.status, 'failed');
  assert.equal(failed.payload.error, 'expired');
});

test('cancelLogin: sends account/login/cancel and emits canceled state', async () => {
  const { session, events } = makeSession();
  const calls = [];
  session.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'account/login/cancel') return { status: 'canceled' };
    return {};
  };
  session.notify = method => calls.push({ method, params: null });

  const response = await session.cancelLogin('login_cancel');

  assert.deepEqual(calls.map(c => c.method), ['initialize', 'initialized', 'account/login/cancel']);
  assert.deepEqual(calls.at(-1).params, { loginId: 'login_cancel' });
  assert.equal(response.status, 'canceled');
  const canceled = byType(events, 'account_login').at(-1);
  assert.equal(canceled.payload.status, 'canceled');
  assert.equal(canceled.payload.loginId, 'login_cancel');
});

test('P1 native controls call stable app-server methods with protocol params', async () => {
  const { session } = makeSession();
  session.sessionId = 'thr_source';
  const calls = [];
  session.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/list') return { data: [{ id: 'thr_list', preview: 'hello' }], nextCursor: null };
    if (method === 'thread/rollback') return { thread: { id: 'thr_source', turns: [] } };
    if (method === 'model/list') return { data: [{ id: 'm1', model: 'gpt-5.5', displayName: 'GPT-5.5' }], nextCursor: null };
    if (method === 'modelProvider/capabilities/read') return { namespaceTools: true, imageGeneration: false, webSearch: true };
    if (method === 'fs/readDirectory') return { entries: [] };
    if (method === 'fs/readFile') return { dataBase64: Buffer.from('readme').toString('base64') };
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'u@example.com', planType: 'plus' }, requiresOpenaiAuth: false };
    if (method === 'account/usage/read') return { summary: { lifetimeTokens: 10 }, dailyUsageBuckets: [] };
    if (method === 'account/rateLimits/read') return { rateLimits: { limitId: 'codex' }, rateLimitsByLimitId: null, rateLimitResetCredits: null };
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'github', authStatus: { type: 'unauthenticated' } }], nextCursor: null };
    if (method === 'skills/list') return { data: [{ cwd: '/tmp/work', skills: [], errors: [] }] };
    if (method === 'externalAgentConfig/detect') return { items: [{ itemType: { type: 'agentsMd' }, description: 'AGENTS.md', cwd: '/tmp/work', details: null }] };
    if (method === 'externalAgentConfig/import') return { importId: 'import_1' };
    return {};
  };
  session.notify = method => calls.push({ method, params: null });

  await session.listThreads({ archived: true, limit: 25, searchTerm: 'hello' });
  await session.archiveThread('thr_source');
  await session.unarchiveThread('thr_source');
  await session.deleteThread('thr_source');
  await session.renameThread('thr_source', 'Mobile run');
  await session.compactThread();
  await session.rollbackThread({ numTurns: 2 });
  await session.listModels({ includeHidden: true });
  await session.readModelProviderCapabilities();
  await session.readDirectory('/tmp/work');
  await session.readFile('/tmp/work/README.md');
  await session.readAccount();
  await session.readUsage();
  await session.readRateLimits();
  await session.listMcpServerStatus({ limit: 10 });
  await session.listSkills({ forceReload: true });
  await session.detectExternalAgentConfig({ includeHome: false });
  await session.importExternalAgentConfig([{ itemType: { type: 'agentsMd' }, description: 'AGENTS.md', cwd: '/tmp/work', details: null }]);

  assert.deepEqual(calls.map(c => c.method), [
    'initialize', 'initialized', 'thread/list',
    'thread/archive',
    'thread/unarchive',
    'thread/delete',
    'thread/name/set',
    'thread/compact/start',
    'thread/rollback',
    'model/list',
    'modelProvider/capabilities/read',
    'fs/readDirectory',
    'fs/readFile',
    'account/read',
    'account/usage/read',
    'account/rateLimits/read',
    'mcpServerStatus/list',
    'skills/list',
    'externalAgentConfig/detect',
    'externalAgentConfig/import',
  ]);
  assert.deepEqual(calls[2].params, { cwd: '/tmp/work', archived: true, limit: 25, searchTerm: 'hello' });
  assert.deepEqual(calls[5].params, { threadId: 'thr_source' });
  assert.deepEqual(calls[6].params, { threadId: 'thr_source', name: 'Mobile run' });
  assert.deepEqual(calls[7].params, { threadId: 'thr_source' });
  assert.deepEqual(calls[8].params, { threadId: 'thr_source', numTurns: 2 });
  assert.deepEqual(calls[9].params, { includeHidden: true, limit: 100 });
  assert.deepEqual(calls[10].params, {});
  assert.deepEqual(calls[11].params, { path: '/tmp/work' });
  assert.deepEqual(calls[12].params, { path: '/tmp/work/README.md' });
  assert.equal(calls[13].params, undefined);
  assert.equal(calls[14].params, undefined);
  assert.equal(calls[15].params, undefined);
  assert.deepEqual(calls[16].params, { detail: 'toolsAndAuthOnly', limit: 10, threadId: 'thr_source' });
  assert.deepEqual(calls[17].params, { cwds: ['/tmp/work'], forceReload: true });
  assert.deepEqual(calls[18].params, { includeHome: false, cwds: ['/tmp/work'] });
  assert.deepEqual(calls[19].params, {
    migrationItems: [{ itemType: { type: 'agentsMd' }, description: 'AGENTS.md', cwd: '/tmp/work', details: null }],
    source: 'mobile',
  });
});

// review 默认走 inline：审查跑在当前 thread 上，事件沿用现有的 turn 事件流。
// detached 会开一条新 thread，手机端得订阅并在两条流之间切换——那是另一件事。
test('startReview 默认审未提交改动，inline 跑在当前 thread 上', async () => {
  const { session } = makeSession();
  const calls = [];
  session.request = async (method, params) => {
    calls.push({ method, params });
    return { turn: { id: 'turn_1' }, reviewThreadId: 'thr_source' };
  };

  const result = await session.startReview({ threadId: 'thr_source' });
  session.dispose();

  assert.deepEqual(calls.at(-1), {
    method: 'review/start',
    params: {
      threadId: 'thr_source',
      target: { type: 'uncommittedChanges' },
      delivery: 'inline',
    },
  });
  assert.equal(result.reviewThreadId, 'thr_source');
});

test('startReview 带指令时改用 custom target，指令原样透传给模型', async () => {
  const { session } = makeSession();
  const calls = [];
  session.request = async (method, params) => {
    calls.push({ method, params });
    return { turn: { id: 'turn_1' }, reviewThreadId: 'thr_source' };
  };

  await session.startReview({ threadId: 'thr_source', instructions: '  重点看并发安全  ' });
  session.dispose();

  assert.deepEqual(calls.at(-1).params, {
    threadId: 'thr_source',
    target: { type: 'custom', instructions: '重点看并发安全' },
    delivery: 'inline',
  });
});

test('startReview 缺 threadId 时直接报错，不发出没有目标的请求', async () => {
  const { session } = makeSession();
  const calls = [];
  session.request = async (method, params) => {
    calls.push({ method, params });
    return {};
  };

  await assert.rejects(() => session.startReview({ threadId: '' }), /threadId/);
  session.dispose();
  assert.equal(calls.some(c => c.method === 'review/start'), false);
});

// 必须在**观察到响应**这一刻就记下 turn，不能等 request() 的 await 返回：响应和该
// turn 的第一条通知可能在同一个 stdout chunk 里，而 host 给带 turnId 的通知找 owner
// 时会回落到 currentTurnId 比对。晚一个 microtask，第一条通知就被判成无主帧丢掉——
// 表现是审查结果稳定少掉第一个字符。
test('review/start 的响应一被观察到就记下 currentTurnId', () => {
  const { session } = makeSession();
  session.observeTransportFrame({
    direction: 'inbound',
    method: 'review/start',
    frame: { id: 1, result: { turn: { id: 'turn-r' }, reviewThreadId: 'thr-a' } },
  });
  assert.equal(session.currentTurnId, 'turn-r');
  session.dispose();
});

test('updateThreadCollaborationMode writes built-in plan settings without starting a turn', async () => {
  const { session } = makeSession();
  const calls = [];
  session.request = async (method, params) => {
    calls.push({ method, params });
    return {};
  };

  const result = await session.updateThreadCollaborationMode('thr_source', 'plan');
  session.dispose();
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.mode, 'plan');
  assert.deepEqual(calls.filter(call => call.method === 'thread/settings/update'), [{
    method: 'thread/settings/update',
    params: {
      threadId: 'thr_source',
      collaborationMode: {
        mode: 'plan',
        settings: { developer_instructions: null },
      },
    },
  }]);
});

test('updateThreadCollaborationMode defers when app-server does not expose the method', async () => {
  const { session } = makeSession();
  session.request = async method => {
    if (method !== 'thread/settings/update') return {};
    const error = new Error('thread/settings/update requires experimentalApi capability');
    error.code = -32601;
    throw error;
  };

  const result = await session.updateThreadCollaborationMode('thr_source', 'plan');
  session.dispose();
  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.deferred, true);
  assert.equal(result.mode, 'plan');
  assert.equal(session.turnOverrides.collaborationMode, 'plan');
});

test('thread/settings/updated emits the effective collaboration mode', () => {
  const { session, events } = makeSession();
  session.handleNotification('thread/settings/updated', {
    threadId: 'thr_1',
    threadSettings: {
      collaborationMode: { mode: 'plan', settings: { developer_instructions: null } },
    },
  });
  const update = byType(events, 'collaboration_mode').at(-1);
  assert.equal(update.payload.threadId, 'thr_1');
  assert.equal(update.payload.mode, 'plan');
  assert.equal(update.payload.applied, true);
});

test('P1 notifications map native app-server state to frontend envelopes', () => {
  const { session, events } = makeSession();

  session.handleNotification('thread/archived', { threadId: 'thr_1' });
  session.handleNotification('thread/unarchived', { threadId: 'thr_1' });
  session.handleNotification('thread/deleted', { threadId: 'thr_1' });
  session.handleNotification('thread/name/updated', { threadId: 'thr_1', name: 'New name' });
  session.handleNotification('thread/compacted', { threadId: 'thr_1', turnId: 'turn_1' });
  session.handleNotification('account/rateLimits/updated', { rateLimits: { limitId: 'codex' } });
  session.handleNotification('mcpServer/startupStatus/updated', { threadId: null, name: 'github', status: 'ready', error: null });
  session.handleNotification('skills/changed', { cwd: '/tmp/work' });
  session.handleNotification('externalAgentConfig/import/progress', { importId: 'import_1', itemTypeResults: [] });
  session.handleNotification('externalAgentConfig/import/completed', { importId: 'import_1', itemTypeResults: [] });

  assert.deepEqual(byType(events, 'thread_event').map(e => e.payload.event), ['archived', 'unarchived', 'deleted', 'name_updated']);
  assert.deepEqual(byType(events, 'compact').at(-1).payload, { status: 'compacted', threadId: 'thr_1', turnId: 'turn_1' });
  assert.equal(byType(events, 'rate_limits').at(-1).payload.rateLimits.limitId, 'codex');
  assert.equal(byType(events, 'mcp_status').at(-1).payload.name, 'github');
  assert.equal(byType(events, 'skills_changed').at(-1).payload.cwd, '/tmp/work');
  assert.deepEqual(byType(events, 'external_agent_config_import').map(e => e.payload.status), ['progress', 'completed']);
});

test('P2 admin controls call stable app-server methods with protocol params', async () => {
  const { session } = makeSession();
  session.sessionId = 'thr_admin';
  const calls = [];
  session.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'mcpServer/tool/call') return { result: { ok: true } };
    return {};
  };
  session.notify = method => calls.push({ method, params: null });

  await session.writeConfigValue({
    keyPath: 'model',
    value: 'gpt-5.5',
    mergeStrategy: 'replace',
    filePath: '/tmp/config.toml',
    expectedVersion: 'v1',
  });
  await session.writeConfigBatch({
    edits: [{ keyPath: 'profiles.mobile.approval_policy', value: 'on-request', mergeStrategy: 'upsert' }],
    reloadUserConfig: true,
  });
  await session.installPlugin({ pluginName: 'gh', remoteMarketplaceName: 'official' });
  await session.uninstallPlugin('plugin_gh');
  await session.marketplaceAdd({ source: 'https://example.com/market.git', refName: 'main', sparsePaths: ['plugins'] });
  await session.marketplaceRemove('community');
  await session.marketplaceUpgrade('community');
  await session.writeFile('/tmp/work/admin.txt', Buffer.from('hello').toString('base64'));
  await session.removePath('/tmp/work/admin.txt', { recursive: false, force: true });
  await session.copyPath({ sourcePath: '/tmp/work/a.txt', destinationPath: '/tmp/work/b.txt', recursive: false });
  await session.callMcpTool({ server: 'github', tool: 'search', arguments: { q: 'repo' } });
  await session.logoutAccount();

  assert.deepEqual(calls.map(c => c.method), [
    'initialize', 'initialized',
    'config/value/write',
    'config/batchWrite',
    'plugin/install',
    'plugin/uninstall',
    'marketplace/add',
    'marketplace/remove',
    'marketplace/upgrade',
    'fs/writeFile',
    'fs/remove',
    'fs/copy',
    'mcpServer/tool/call',
    'account/logout',
  ]);
  assert.deepEqual(calls[2].params, {
    keyPath: 'model',
    value: 'gpt-5.5',
    mergeStrategy: 'replace',
    filePath: '/tmp/config.toml',
    expectedVersion: 'v1',
  });
  assert.deepEqual(calls[3].params, {
    edits: [{ keyPath: 'profiles.mobile.approval_policy', value: 'on-request', mergeStrategy: 'upsert' }],
    reloadUserConfig: true,
  });
  assert.deepEqual(calls[4].params, { pluginName: 'gh', remoteMarketplaceName: 'official' });
  assert.deepEqual(calls[5].params, { pluginId: 'plugin_gh' });
  assert.deepEqual(calls[6].params, { source: 'https://example.com/market.git', refName: 'main', sparsePaths: ['plugins'] });
  assert.deepEqual(calls[7].params, { marketplaceName: 'community' });
  assert.deepEqual(calls[8].params, { marketplaceName: 'community' });
  assert.deepEqual(calls[9].params, { path: '/tmp/work/admin.txt', dataBase64: Buffer.from('hello').toString('base64') });
  assert.deepEqual(calls[10].params, { path: '/tmp/work/admin.txt', recursive: false, force: true });
  assert.deepEqual(calls[11].params, { sourcePath: '/tmp/work/a.txt', destinationPath: '/tmp/work/b.txt', recursive: false });
  assert.deepEqual(calls[12].params, { threadId: 'thr_admin', server: 'github', tool: 'search', arguments: { q: 'repo' } });
  assert.equal(calls[13].params, undefined);
});

test('item/commandExecution/outputDelta: streams raw terminal output including ANSI', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/commandExecution/outputDelta', {
    itemId: 'cmd1',
    delta: '\u001b[32mPASS\u001b[0m\n',
    stream: 'stdout',
  });
  const td = byType(events, 'tool_output_delta')[0];
  assert.ok(td);
  assert.equal(td.payload.toolUseId, 'cmd1');
  assert.equal(td.payload.text, '\u001b[32mPASS\u001b[0m\n');
  assert.equal(td.payload.stream, 'stdout');
});

// ---- 边界条件和错误路径 ----

test('handleLine: 忽略无效 JSON', () => {
  const { session, events } = makeSession();
  assert.doesNotThrow(() => session.handleLine('not valid json{{{'));
  assert.equal(events.length, 0);
});

test('handleLine: 忽略空行', () => {
  const { session, events } = makeSession();
  assert.doesNotThrow(() => session.handleLine(''));
  assert.doesNotThrow(() => session.handleLine('   '));
  assert.equal(events.length, 0);
});

test('item/completed(agentMessage with empty text): 不发 text_delta', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', { item: { type: 'agentMessage', id: 'm_empty', text: '' } });
  assert.equal(byType(events, 'text_delta').length, 0);
});

test('item/agentMessage/delta with empty delta: 不发 text_delta', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/agentMessage/delta', { delta: '' });
  assert.equal(byType(events, 'text_delta').length, 0);
});

test('item/completed(commandExecution with non-zero exit): ok=false', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', {
    item: { type: 'commandExecution', id: 'c_fail', command: 'false', aggregatedOutput: '', exitCode: 1, status: 'completed' }
  });
  const tr = byType(events, 'tool_result')[0];
  assert.ok(tr);
  assert.equal(tr.payload.ok, false);
  assert.equal(tr.payload.exitCode, 1);
});

test('item/completed(unknown item type): emits raw_item without crashing', () => {
  const { session, events } = makeSession();
  assert.doesNotThrow(() => session.handleNotification('item/completed', { item: { type: 'unknownType', id: 'x1' } }));
  const raw = byType(events, 'raw_item').at(-1);
  assert.ok(raw);
  assert.equal(raw.payload.completed, true);
  assert.equal(raw.payload.item.type, 'unknownType');
  assert.equal(raw.payload.item.id, 'x1');
});

// 协议基线从 0.142.5 升到 0.147.0 时,ServerNotification 净增了这三项。bridge 一个都没接,
// 靠的是 handleNotification 的 switch 落空——这份「不接也不炸」必须锁住:它没有 default 分支,
// 将来谁给 switch 补一句兜底 emit,这三项就会变成用户看得见的噪声。
test('0.147.0 新增的通知落空即可,既不抛也不往事件流里掺东西', () => {
  const { session, events } = makeSession();
  const before = events.length;
  for (const method of ['thread/environment/connected', 'thread/environment/disconnected', 'rawResponse/completed']) {
    assert.doesNotThrow(() => session.handleNotification(method, {}), `${method} 不该抛`);
  }
  assert.equal(events.length, before, '未接的新通知不该产生任何事件');
});

test('dispose: 标记 disposed 并清理', () => {
  const { session } = makeSession();
  session.child = { stdin: { write: () => {} }, kill: () => {}, on: () => {} };
  session.idleTimer = setInterval(() => {}, 1000);
  session.dispose();
  assert.equal(session.disposed, true);
  assert.equal(session.child, null);
});

test('send: 空文本返回 false', async () => {
  const { session } = makeSession();
  assert.equal(await session.send(''), false);
  assert.equal(await session.send('   '), false);
  assert.equal(await session.send(null), false);
});

test('send: disposed session returns false', async () => {
  const { session } = makeSession();
  session.disposed = true;
  assert.equal(await session.send('hello'), false);
});

test('handleServerRequest: 非审批请求被安全兜底回应', () => {
  const { session } = makeSession();
  const writes = [];
  session.child = { stdin: { write: s => writes.push(s) } };
  session.handleLine(JSON.stringify({ method: 'thread/unknownMethod', id: 99, params: {} }));
  const sent = JSON.parse(writes[0]);
  assert.equal(sent.id, 99);
  assert.deepEqual(sent.error, {
    code: -32601,
    message: 'Unsupported server request: thread/unknownMethod'
  });
});

// ---- 未覆盖路径补充 ----

test('checkIdle: busy 超时触发中断', () => {
  const { session, events } = makeSession();
  session.busy = true;
  session.lastActivity = Date.now() - 700000; // 超过 10 分钟
  session.idleTimeoutMs = 600000;
  session.child = { stdin: { write: () => {} }, on: () => {}, kill: () => {} };
  session.sessionId = 'idle_test';
  session.checkIdle();
  const err = events.find(e => e.type === 'error');
  assert.ok(err, '应 emit error 事件');
  assert.match(err.payload.message, /静默/);
  assert.equal(session.busy, false);
});

test('checkIdle: 非 busy 状态不触发', () => {
  const { session, events } = makeSession();
  session.busy = false;
  session.lastActivity = Date.now() - 700000;
  session.checkIdle();
  assert.equal(events.length, 0);
});

test('checkIdle: 未超时不触发', () => {
  const { session, events } = makeSession();
  session.busy = true;
  session.lastActivity = Date.now();
  session.idleTimeoutMs = 600000;
  session.checkIdle();
  assert.equal(events.length, 0);
});

test('emit: buffer 超过上限时裁剪', () => {
  const { session } = makeSession();
  // 填充 buffer 到上限
  for (let i = 0; i < 500; i++) {
    session.emit('text_delta', { text: `char ${i}` });
  }
  assert.equal(session.buffer.length, 500);
  assert.equal(session.bufferTrimmed, false);
  // 再发一条，触发裁剪
  session.emit('text_delta', { text: 'overflow' });
  assert.equal(session.buffer.length, 500);
  assert.equal(session.bufferTrimmed, true);
  // 最旧的事件被移除
  assert.equal(session.buffer[0].payload.text, 'char 1');
});

test('eventsSince: 返回指定 seq 之后的事件', () => {
  const { session } = makeSession();
  session.emit('text_delta', { text: 'a' }); // seq 1
  session.emit('text_delta', { text: 'b' }); // seq 2
  session.emit('text_delta', { text: 'c' }); // seq 3
  const result = session.eventsSince(1);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].payload.text, 'b');
  assert.equal(result.events[1].payload.text, 'c');
  assert.equal(result.gap, false);
});

test('eventsSince: buffer 裁剪后正确返回剩余事件', () => {
  const { session } = makeSession();
  // 填充 buffer 到上限触发裁剪
  for (let i = 0; i < 501; i++) {
    session.emit('text_delta', { text: `char ${i}` });
  }
  assert.equal(session.bufferTrimmed, true);
  assert.equal(session.buffer.length, 500);
  // 返回 seq > 500 的事件（只有最后一条）
  const result = session.eventsSince(500);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].payload.text, 'char 500');
});

test('clearQueue: 清空队列并返回丢弃数量', () => {
  const { session, events } = makeSession();
  session.inputQueue = [{ text: 'a' }, { text: 'b' }];
  const dropped = session.clearQueue('test_clear');
  assert.equal(dropped, 2);
  assert.equal(session.inputQueue.length, 0);
  const qe = events.find(e => e.type === 'queue_cleared');
  assert.ok(qe);
  assert.equal(qe.payload.dropped, 2);
  assert.equal(qe.payload.reason, 'test_clear');
});

// ---- idle watchdog 生命周期 ----

function makeFakeTransportFactory() {
  return () => {
    const transport = {
      child: null,
      start() {
        transport.child = { stdin: { write() {} } };
        return transport.child;
      },
      request: async () => ({}),
      notify() {},
      dispose() {},
    };
    return transport;
  };
}

test('handleTransportError clears the idle watchdog instead of leaking it', () => {
  const { session } = makeSession({ transportFactory: makeFakeTransportFactory() });
  session.spawnIfNeeded();
  assert.ok(session.idleTimer, 'spawn 应建立 idle watchdog');

  session.handleTransportError(new Error('spawn failed'));
  assert.equal(session.idleTimer, null, 'transport 出错后必须清掉 watchdog');

  session.dispose();
});

test('repeated transport errors do not leak idle watchdog intervals', () => {
  // handleTransportExit 清了 timer，handleTransportError 没有。下一次请求走
  // spawnIfNeeded 时 child 为 null，于是无条件再建一个 interval，旧的失联。
  // 这些 interval 没有 unref，泄漏后还会继续把进程吊住并重复触发 checkIdle。
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const live = new Set();
  globalThis.setInterval = (callback, delay, ...args) => {
    const handle = originalSetInterval(callback, delay, ...args);
    if (delay === 30_000) live.add(handle);
    return handle;
  };
  globalThis.clearInterval = handle => {
    live.delete(handle);
    return originalClearInterval(handle);
  };

  try {
    const { session } = makeSession({ transportFactory: makeFakeTransportFactory() });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      session.spawnIfNeeded();
      session.handleTransportError(new Error(`spawn failed ${attempt}`));
    }
    assert.equal(live.size, 0, '每次 transport 出错都应清掉自己的 watchdog');
    session.dispose();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

// ---- 空闲回收资格 ----

test('isReclaimable refuses while the runtime still holds work', () => {
  // 网关侧另有「没有任何 socket 在看」这一条；runtime 只回答自己手上有没有活。
  const { session } = makeSession();
  session.lastActivity = 1_000;
  const idleSince = 5_000;

  assert.equal(session.isReclaimable(idleSince), true, '空闲且久未活动的实例可以回收');

  session.busy = true;
  assert.equal(session.isReclaimable(idleSince), false, 'turn 正在跑时不能回收');
  session.busy = false;

  session.pendingApprovals.add(1);
  assert.equal(session.isReclaimable(idleSince), false, '有待人处理的审批时不能回收');
  session.pendingApprovals.clear();

  session.inputQueue.push({ text: 'queued', queuedAt: Date.now() });
  assert.equal(session.isReclaimable(idleSince), false, '排队消息未发完时不能回收');
  session.inputQueue.length = 0;

  session.lastActivity = 9_000;
  assert.equal(session.isReclaimable(idleSince), false, '最近还有活动的实例不能回收');
  session.lastActivity = 1_000;

  session.disposed = true;
  assert.equal(session.isReclaimable(idleSince), false, '已 dispose 的实例不重复回收');
});

// ---- 回收资格所依赖的信号 ----

test('lastActivity tracks request/response traffic, not just notifications', async () => {
  // isReclaimable 拿 lastActivity 当空闲判据，但 host 模式下 AppServerHost 构造
  // transport 时没传 onActivity，所以 RPC 往返（thread/resume、command/exec、审批
  // 请求）全都不算「活动」。一个正在跑长命令的 runtime 会被判成空闲。
  const { session } = makeSession();
  session.lastActivity = 1_000;

  session.observeTransportFrame({
    direction: 'outbound',
    method: 'thread/resume',
    frame: { method: 'thread/resume', id: 1, params: { threadId: 'thr_1' } },
  });
  assert.ok(session.lastActivity > 1_000, 'RPC 往返应算作活动');

  session.lastActivity = 1_000;
  session.handleServerRequest(7, 'item/commandExecution/requestApproval', {
    threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_1', command: ['ls'],
  });
  assert.ok(session.lastActivity > 1_000, '收到审批请求应算作活动');
  session.dispose();
});

test('dispose rejects in-flight requests instead of leaving them pending', { timeout: 3000 }, async () => {
  // dispose() 里的 rejectAllPending 清的是 legacy 路径的 map（host 模式下恒空）；
  // 真正的在途请求躺在 host.transport.pending 里，条目的 context.runtime 是强引用，
  // 于是「被回收」的 runtime 连同它 500 条事件缓冲一起留在内存里，调用方永不 settle。
  const { AppServerHost } = await import('../../src/agent/app-server-host.js');
  const { ThreadRegistry } = await import('../../src/sessions/thread-registry.js');
  const host = new AppServerHost({
    registry: new ThreadRegistry(),
    spawnImpl: () => ({
      stdin: { write: () => true, on() {} },
      stdout: { on() {} },
      stderr: { on() {} },
      on() {},
      kill() {},
    }),
  });
  const { session } = makeSession({ host });

  const inFlight = session.request('thread/resume', { threadId: 'thr_1' });
  assert.equal(host.transport.pending.size, 1);

  session.dispose();
  await assert.rejects(inFlight, /dispos/i, '在途请求应在 dispose 时被拒绝');
  assert.equal(host.transport.pending.size, 0, 'transport.pending 里不应残留对已回收 runtime 的引用');
  host.dispose();
});

test('a disposed runtime is not re-attached by a late response', { timeout: 3000 }, async () => {
  // ensureInitialized 的 await 解开后会 notify('initialized')，那条路径会 attach()。
  // 如果 runtime 已经被回收，它就这样被塞回 host.runtimes——而 detach 只由 dispose
  // 调用，不会再发生第二次，于是永久泄漏。
  const { AppServerHost } = await import('../../src/agent/app-server-host.js');
  const { ThreadRegistry } = await import('../../src/sessions/thread-registry.js');
  const host = new AppServerHost({
    registry: new ThreadRegistry(),
    spawnImpl: () => ({
      stdin: { write: () => true, on() {} },
      stdout: { on() {} },
      stderr: { on() {} },
      on() {},
      kill() {},
    }),
  });
  const { session } = makeSession({ host });
  host.attach(session);
  assert.equal(host.runtimes.has(session), true);

  session.dispose();
  assert.equal(host.runtimes.has(session), false);

  host.attach(session);
  assert.equal(host.runtimes.has(session), false, '已 dispose 的 runtime 不应被重新 attach');
  host.dispose();
});

// 经 item/started|completed 送出：{type:"reasoning", id:"rs_...", summary:[...], content:[...]}。
// 之前 handleItem 不认这个 type，162 次 reasoning 全部掉进 raw_item 兜底，界面上显示成
// 「🧾 Raw」而不是 reasoning 卡。
test('item/completed: reasoning item 渲染成 reasoning 而不是 raw 兜底', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', {
    threadId: 'thr-1',
    turnId: 'turn-1',
    item: {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: '先读协议契约' }],
      content: [],
    },
  });
  assert.equal(byType(events, 'raw_item').length, 0, 'reasoning 不该落进 raw_item 兜底');
  const reasoning = byType(events, 'reasoning');
  assert.equal(reasoning.length, 1);
  assert.match(reasoning[0].payload.text, /先读协议契约/);
  assert.equal(reasoning[0].payload.channel, 'summary');
  assert.equal(reasoning[0].payload.itemId, 'rs_1');
});

test('reasoning item 的 summary 兼容纯字符串与 content 回退', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/completed', {
    item: { type: 'reasoning', id: 'rs_2', summary: ['直接是字符串'] },
  });
  session.handleNotification('item/completed', {
    item: { type: 'reasoning', id: 'rs_3', summary: [], content: [{ text: '只有 content' }] },
  });
  const texts = byType(events, 'reasoning').map(e => e.payload.text);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /直接是字符串/);
  assert.match(texts[1], /只有 content/);
  assert.equal(byType(events, 'raw_item').length, 0);
});

test('reasoning 的 item/started 不重复发，completed 时才出正文', () => {
  const { session, events } = makeSession();
  session.handleNotification('item/started', {
    item: { type: 'reasoning', id: 'rs_4', summary: [], content: [] },
  });
  assert.equal(byType(events, 'reasoning').length, 0, 'started 阶段还没有正文，不该发空 reasoning');
  assert.equal(byType(events, 'raw_item').length, 0, 'started 阶段也不该落进 raw 兜底');
  session.handleNotification('item/completed', {
    item: { type: 'reasoning', id: 'rs_4', summary: [{ text: '结论' }], content: [] },
  });
  assert.equal(byType(events, 'reasoning').length, 1);
});

// 审批审计此前写在 this.cwd 里——也就是用户的仓库。`git clean -xfd` 会连同证据一起删掉，
// 它还会出现在用户的 git status 里。审计是「手机丢了它被用来干过什么」的唯一答案，
// 不该放在一个随时会被清理的地方。
test('审批审计落点可注入，默认不写进用户工作区', () => {
  const { session } = makeSession({ cwd: '/tmp/user-repo', approvalAuditPath: '/var/data/security-audit.jsonl' });
  assert.equal(session.approvalBroker.auditPath, '/var/data/security-audit.jsonl');
  assert.ok(!session.approvalBroker.auditPath.startsWith('/tmp/user-repo'), '不得落在工作区内');
});

// ---- RECOVER-01：断线重连时「只补缺失增量」的判据 ----
//
// `gap` 是三个条件与起来的：lastSeq > 0 && bufferTrimmed && oldest > lastSeq + 1。
// 它判错的方向不对称：
//   该 true 判成 false → 客户端以为收全了，而中间那段已经被环形缓冲裁掉——**静默丢事件**，
//                        这正是 RECOVER-01 要防的东西
//   该 false 判成 true → 多做一次 thread/read 全量重建，慢但不丢
//
// 既有的两条 eventsSince 测试里，裁剪那条**从没断言过 gap**——它只看了 events 的内容。
test('eventsSince: 客户端要的事件已被裁掉时报 gap，逼服务端走全量重建', () => {
  const { session } = makeSession();
  // 缓冲上限 500。发 600 条之后，最早还留着的是 seq 101。
  for (let index = 0; index < 600; index += 1) session.emit('text_delta', { text: `c${index}` });
  assert.equal(session.bufferTrimmed, true, '前置：缓冲必须真的裁剪过');
  assert.equal(session.buffer[0].seq, 101, '前置：最早留存的是 seq 101');

  const result = session.eventsSince(1);
  assert.equal(result.gap, true,
    '客户端停在 seq 1，而缓冲里最早的是 101——2..100 已经没了，必须报 gap');
  assert.equal(result.epoch, session.epoch, 'gap 时也要带上 epoch，客户端靠它判断实例有没有换过');
});

test('eventsSince: 三个条件各自都必要，缺一个就不该报 gap', () => {
  // 1) 从没裁剪过：缓冲连续，无论客户端停在哪都不是 gap。
  {
    const { session } = makeSession();
    for (let index = 0; index < 10; index += 1) session.emit('text_delta', { text: `c${index}` });
    assert.equal(session.bufferTrimmed, false, '前置：没到上限');
    assert.equal(session.eventsSince(1).gap, false, '缓冲连续就不是 gap');
  }

  // 2) 裁剪过，但客户端要的那一段还在缓冲里：不是 gap。
  {
    const { session } = makeSession();
    for (let index = 0; index < 600; index += 1) session.emit('text_delta', { text: `c${index}` });
    assert.equal(session.eventsSince(100).gap, false,
      '客户端停在 100，缓冲最早是 101——正好接得上，不是 gap');
    assert.equal(session.eventsSince(500).gap, false, '更靠后的更接得上');
  }

  // 3) ⚠ 反直觉：全新客户端（lastSeq = 0）即使缓冲裁剪过也**不**报 gap。
  // 它本来就没有历史可补，该走的是正常的首次加载，不是「重建」那条更贵的路。
  {
    const { session } = makeSession();
    for (let index = 0; index < 600; index += 1) session.emit('text_delta', { text: `c${index}` });
    assert.equal(session.eventsSince(0).gap, false,
      '全新客户端没有「缺失的增量」这回事，不该被判成 gap');
    assert.equal(session.eventsSince(0).events.length, 500, '但它要拿到缓冲里现有的全部');
  }
});

// 空缓冲时 oldest 取 this.seq + 1，避免读 buffer[0] 崩溃。这个兜底值同时要保证
// 「刚建好、什么都没发过」的实例不会被误判成 gap。
test('eventsSince: 缓冲为空时既不崩溃也不误报 gap', () => {
  const { session } = makeSession();
  const fresh = session.eventsSince(0);
  assert.deepEqual(fresh.events, []);
  assert.equal(fresh.gap, false);
  assert.equal(fresh.epoch, session.epoch);

  // 发过又被 clearQueue 之类清掉的情况：seq 已经推进，但缓冲里没有对应条目。
  session.emit('text_delta', { text: 'a' });
  session.buffer = [];
  assert.equal(session.eventsSince(1).gap, false,
    'seq 1 之后没有新事件，客户端已经是最新——不该报 gap 逼它重建');
});

// ---- 通知的会话归属与轮次终态 ----
//
// 这一片是 handleNotification 的字段回落族：`threadId: params.threadId || this.sessionId || null`
// 之类的写法在文件里出现 4 次，改成 && 之后事件带着 null 或错误的 threadId 送出去，
// 客户端要么把它归到别的对话，要么直接丢掉——两种都是静默的。

test('通知带的会话归属：优先用通知自己的 threadId，其次才回落到当前会话', () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_current';

  // 错误通知自带 threadId：必须用它，不能被当前会话覆盖。
  session.handleErrorNotification({ message: 'boom', threadId: 'thr_other', turnId: 'turn_x' });
  const [errorEvent] = byType(events, 'system').slice(-1);
  assert.equal(errorEvent.payload.threadId, 'thr_other', '通知自带的归属优先');
  assert.equal(errorEvent.payload.turnId, 'turn_x');

  // 不带 threadId 时回落到 null（错误通知这一处不回落到当前会话）。
  session.handleErrorNotification({ message: 'boom2' });
  const [bare] = byType(events, 'system').slice(-1);
  assert.equal(bare.payload.threadId, null, '拿不到归属时给 null，而不是 undefined');
  assert.equal(bare.payload.turnId, null);
});

test('thread_event 的归属与名字各自独立回落', () => {
  const { session, events } = makeSession();

  session.emitThreadEvent('archived', { threadId: 'thr_1', name: 'A' });
  session.emitThreadEvent('name_updated', { threadId: 'thr_2', threadName: 'B' });
  session.emitThreadEvent('deleted', {});

  assert.deepEqual(byType(events, 'thread_event').map(e => [e.payload.threadId, e.payload.name]),
    [['thr_1', 'A'], ['thr_2', 'B'], [null, null]],
    'name 与 threadName 是两种上游写法，都要认；都没有时给 null');
});

// willRetry 决定这条错误是「正在重试」还是「失败了」。判反的后果不对称：
// 把重试判成失败，用户看到一条其实会自动恢复的红色报错；
// 把失败判成重试，用户以为还在跑，而实际上什么都不会再发生。
test('willRetry 只认严格 true，决定错误的措辞与状态', () => {
  for (const [willRetry, expectError, expectStatus] of [
    [true, false, 'turn_retrying'],
    [false, true, 'server_error'],
    [undefined, true, 'server_error'],
    ['true', true, 'server_error'],
  ]) {
    const { session, events } = makeSession();
    session.handleErrorNotification({ message: 'boom', willRetry });
    const [systemEvent] = byType(events, 'system').slice(-1);
    assert.equal(systemEvent.payload.isError, expectError, `willRetry=${String(willRetry)}`);
    assert.equal(systemEvent.payload.willRetry, willRetry === true);
    const [statusEvent] = byType(events, 'status').slice(-1);
    assert.equal(statusEvent.payload.reason, expectStatus);
  }
});

// 轮次终态决定用户看到「完成」还是「失败」，也决定 busy 会不会被放开。
// status 的回落顺序写反的话，一个 failed 的轮次会被当成 completed——
// 用户看到绿色的完成标记，而任务其实没做。
test('轮次终态：turn.status 优先于 status，都没有才当成 completed', () => {
  const cases = [
    ['turn.status 优先', { turn: { status: 'failed' }, status: 'completed' }, false, 'turn_failed'],
    ['只有顶层 status', { status: 'failed' }, false, 'turn_failed'],
    ['中断', { turn: { status: 'interrupted' } }, false, 'turn_interrupted'],
    ['都没有时按完成处理', {}, true, 'turn_completed'],
    ['认不出的终态不当成成功', { status: 'weird' }, false, 'turn_completed'],
  ];

  for (const [label, params, expectOk, expectReason] of cases) {
    const { session, events } = makeSession();
    session.busy = true;
    session.handleTurnCompleted(params);
    assert.equal(session.busy, false, `${label}：无论哪条终态都要放开 busy`);
    const [statusEvent] = byType(events, 'status').slice(-1);
    assert.equal(statusEvent.payload.reason, expectReason, label);
    if (expectOk) {
      assert.equal(byType(events, 'result').slice(-1)[0].payload.ok, true, label);
    } else if (expectReason === 'turn_completed') {
      assert.equal(byType(events, 'result').slice(-1)[0].payload.ok, false,
        `${label}：认不出的状态不能报成功`);
    } else {
      assert.equal(byType(events, 'error').length > 0, true, `${label}：失败要发 error 事件`);
    }
  }
});

// ---- 进程退出通知的字段归一 ----
//
// 上游对进程标识用过两个名字（processHandle / processId），输出字段可能整个缺失。
// ---- 线程状态与 busy ----
//
// busy 决定发送按钮是"发送"还是"停止"，也决定队列会不会继续排下去。
// 判反的后果：turn 结束了界面还停在运行中，用户点不了发送，也看不出为什么。
test('线程状态里只有三种终态会放开 busy，active 会置上', () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_1';

  session.handleNotification('thread/status/changed', { threadId: 'thr_1', status: { type: 'active' } });
  assert.equal(session.busy, true, 'active 时置上 busy');

  for (const type of ['idle', 'notLoaded', 'systemError']) {
    session.busy = true;
    session.handleNotification('thread/status/changed', { threadId: 'thr_1', status: { type } });
    assert.equal(session.busy, false, `${type} 是终态，必须放开 busy`);
  }

  // 认不出的状态既不置上也不放开——保持原样比猜一个方向安全。
  session.busy = true;
  session.handleNotification('thread/status/changed', { threadId: 'thr_1', status: { type: 'whatever' } });
  assert.equal(session.busy, true, '认不出的状态不该改动 busy');

  assert.equal(byType(events, 'thread_status').slice(-1)[0].payload.threadId, 'thr_1');
});

test('线程状态事件的归属：通知没带 threadId 时回落到当前会话', () => {
  const { session, events } = makeSession();
  session.sessionId = 'thr_current';

  session.handleNotification('thread/status/changed', { status: { type: 'idle' } });
  assert.equal(byType(events, 'thread_status').slice(-1)[0].payload.threadId, 'thr_current',
    '不带归属时用当前会话，否则客户端不知道这条状态属于谁');

  const fresh = makeSession();
  fresh.session.handleNotification('thread/status/changed', { status: { type: 'idle' } });
  assert.equal(byType(fresh.events, 'thread_status').slice(-1)[0].payload.threadId, null,
    '两个都没有时给 null，不是 undefined');
});

// 外部配置导入的进度/完成事件把上游 params 整个透传出去。
// `...(params || {})` 写成 `&&` 的话，params 存在时反而展开一个空对象——
// 进度里的百分比、完成时的结果全部消失，界面停在"导入中"。
test('外部配置导入的进度与完成事件把上游字段透传出去', () => {
  const { session, events } = makeSession();
  session.handleNotification('externalAgentConfig/import/progress', { done: 3, total: 10 });
  session.handleNotification('externalAgentConfig/import/completed', { imported: 7 });

  const imports = byType(events, 'external_agent_config_import').map(e => e.payload);
  assert.deepEqual(imports, [
    { status: 'progress', done: 3, total: 10 },
    { status: 'completed', imported: 7 },
  ], '上游字段必须原样带出去，只补一个 status');

  // params 缺失时不崩，只发 status。
  const bare = makeSession();
  bare.session.handleNotification('externalAgentConfig/import/progress', undefined);
  assert.deepEqual(byType(bare.events, 'external_agent_config_import')[0].payload, { status: 'progress' });
});
