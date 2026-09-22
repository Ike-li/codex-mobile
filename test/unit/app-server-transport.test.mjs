import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AppServerTransport } from '../../src/agent/app-server-transport.js';

function fakeChild() {
  const child = new EventEmitter();
  const writes = [];
  const killSignals = [];

  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
  };
  child.kill = signal => {
    killSignals.push(signal);
    return true;
  };

  return { child, writes, killSignals };
}

function harness(overrides = {}) {
  const spawned = [];
  const messages = [];
  const exits = [];
  const errors = [];
  const children = [];
  const spawnImpl = (...args) => {
    const fake = fakeChild();
    children.push(fake);
    spawned.push(args);
    return fake.child;
  };
  const transport = new AppServerTransport({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    spawnImpl,
    onMessage: message => messages.push(message),
    onExit: detail => exits.push(detail),
    onError: error => errors.push(error),
    ...overrides,
  });
  return { transport, spawned, messages, exits, errors, children };
}

function jsonWrites(fake) {
  return fake.writes.map(line => JSON.parse(line));
}

// 请求超时定时器在生产代码里是 unref 的（app-server-transport.js 的 request）。
// 服务器进程始终有 HTTP listener 吊着事件循环，所以线上无影响；但在测试里
// 事件循环会在这个定时器触发前排空，node --test 判定「promise 仍挂起而事件
// 循环已结束」，把本测试连同其后所有测试标记为 cancelled —— 退出码是 1，
// 但计数显示 `fail 0`，很容易被当成通过。用一个 ref 住的定时器撑住这段等待。
async function withLiveEventLoop(fn) {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
}

test('start spawns one stdio app-server child and is idempotent while it is alive', () => {
  const { transport, spawned, children } = harness();

  transport.start();
  transport.start();

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0][0], '/fake/codex');
  assert.deepEqual(spawned[0][1], ['app-server']);
  assert.equal(spawned[0][2].cwd, '/workspace');
  assert.deepEqual(spawned[0][2].stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(children.length, 1);
});

test('stdout JSONL is reconstructed across chunks and forwards non-response frames', () => {
  const { transport, messages, errors, children } = harness();
  transport.start();
  const [{ child }] = children;

  child.stdout.emit('data', Buffer.from('{"method":"turn/sta'));
  child.stdout.emit('data', Buffer.from('rted","params":{"threadId":"thr_1"}}\n{"method":"item/started",'));
  child.stdout.emit('data', Buffer.from('"params":{"threadId":"thr_1"}}\n'));

  assert.deepEqual(messages, [
    { method: 'turn/started', params: { threadId: 'thr_1' } },
    { method: 'item/started', params: { threadId: 'thr_1' } },
  ]);
  assert.equal(errors.length, 0);
});

test('stdout activity is reported even before a complete JSONL frame arrives', () => {
  let activityCount = 0;
  const { transport, messages, children } = harness({
    onActivity: () => { activityCount += 1; },
  });
  transport.start();
  const [{ child }] = children;

  child.stdout.emit('data', Buffer.from('{"method":"partial'));

  assert.equal(activityCount, 1);
  assert.deepEqual(messages, []);
});

test('stdout reconstruction preserves UTF-8 characters split across buffer chunks', () => {
  const { transport, messages, children } = harness();
  transport.start();
  const [{ child }] = children;
  const frame = Buffer.from(`${JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { delta: '🙂' },
  })}\n`);
  const emojiStart = frame.indexOf(Buffer.from('🙂'));

  child.stdout.emit('data', frame.subarray(0, emojiStart + 1));
  child.stdout.emit('data', frame.subarray(emojiStart + 1));

  assert.deepEqual(messages, [{
    method: 'item/agentMessage/delta',
    params: { delta: '🙂' },
  }]);
});

test('stderr is drained and forwarded without entering the JSONL parser', () => {
  const stderr = [];
  const { transport, messages, errors, children } = harness({
    onStderr: chunk => stderr.push(String(chunk)),
  });
  transport.start();
  const [{ child }] = children;

  child.stderr.emit('data', Buffer.from('diagnostic only\n'));

  assert.deepEqual(stderr, ['diagnostic only\n']);
  assert.deepEqual(messages, []);
  assert.deepEqual(errors, []);
});

test('request assigns ids and resolves or rejects from JSON-RPC responses', async () => {
  const { transport, children } = harness();
  transport.start();
  const [fake] = children;

  const success = transport.request('thread/list', { limit: 10 });
  const first = jsonWrites(fake)[0];
  assert.deepEqual(first, { method: 'thread/list', id: 1, params: { limit: 10 } });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"data":[]}}\n'));
  assert.deepEqual(await success, { data: [] });

  const failure = transport.request('turn/start', { threadId: 'thr_1' });
  const second = jsonWrites(fake)[1];
  assert.equal(second.id, 2);
  fake.child.stdout.emit('data', Buffer.from('{"id":2,"error":{"code":-32000,"message":"boom","data":{"retry":false}}}\n'));
  await assert.rejects(failure, error => {
    assert.match(error.message, /boom/);
    assert.equal(error.code, -32000);
    assert.deepEqual(error.data, { retry: false });
    return true;
  });
});

test('frame observer sees correlated outbound requests and inbound responses', async () => {
  const frames = [];
  const { transport, children } = harness({
    onFrame: event => frames.push(event),
  });
  transport.start();
  const [fake] = children;

  const pending = transport.request('thread/list', { limit: 5 });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"data":[]}}\n'));
  await pending;

  assert.deepEqual(frames, [
    {
      direction: 'outbound',
      method: 'thread/list',
      frame: { method: 'thread/list', id: 1, params: { limit: 5 } },
    },
    {
      direction: 'inbound',
      method: 'thread/list',
      frame: { id: 1, result: { data: [] } },
    },
  ]);
});

test('request context is returned only to frame observers and never written on the wire', async () => {
  const frames = [];
  const context = { owner: 'runtime-a' };
  const { transport, children } = harness({
    onFrame: event => frames.push(event),
  });
  transport.start();
  const [fake] = children;

  const pending = transport.request('thread/read', { threadId: 'thr-a' }, { context });
  assert.deepEqual(jsonWrites(fake)[0], {
    method: 'thread/read',
    id: 1,
    params: { threadId: 'thr-a' },
  });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"thread":{"id":"thr-a"}}}\n'));
  await pending;

  assert.equal(frames[0].context, context);
  assert.equal(frames[1].context, context);
});

test('notify and response helpers write the expected JSON-RPC frames', () => {
  const { transport, children } = harness();
  transport.start();
  const [fake] = children;

  transport.notify('initialized', {});
  transport.respond('approval-1', { decision: 'accept' });
  transport.respondError(9, -32601, 'unsupported');
  transport.send({ method: 'custom/event', params: { ok: true } });

  assert.deepEqual(jsonWrites(fake), [
    { method: 'initialized', params: {} },
    { id: 'approval-1', result: { decision: 'accept' } },
    { id: 9, error: { code: -32601, message: 'unsupported' } },
    { method: 'custom/event', params: { ok: true } },
  ]);
});

test('request timeout rejects and a malformed line reports an error without stopping parsing', async () => {
  const { transport, messages, errors, children } = harness();
  transport.start();
  const [fake] = children;

  const pending = transport.request('thread/read', { threadId: 'thr_1' }, { timeoutMs: 10 });
  await withLiveEventLoop(() => assert.rejects(pending, /thread\/read timed out after 10ms/));

  fake.child.stdout.emit('data', Buffer.from('not-json\n{"method":"thread/started","params":{"threadId":"thr_2"}}\n'));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Invalid JSON from codex app-server/);
  assert.deepEqual(messages, [
    { method: 'thread/started', params: { threadId: 'thr_2' } },
  ]);
});

test('child exit rejects every pending request, reports exit, and allows an explicit restart', async () => {
  const { transport, spawned, exits, children } = harness();
  transport.start();
  const firstChild = children[0].child;
  const one = transport.request('thread/read', { threadId: 'one' });
  const two = transport.request('thread/read', { threadId: 'two' });

  firstChild.emit('close', 7, 'SIGTERM');

  await assert.rejects(one, /exited.*code 7.*SIGTERM/i);
  await assert.rejects(two, /exited.*code 7.*SIGTERM/i);
  assert.deepEqual(exits, [{ code: 7, signal: 'SIGTERM' }]);

  transport.start();
  assert.equal(spawned.length, 2);
});

test('child error rejects pending work and is reported through onError', async () => {
  const { transport, errors, children } = harness();
  transport.start();
  const [fake] = children;
  const pending = transport.request('thread/list', {});
  const failure = new Error('spawn failed');

  fake.child.emit('error', failure);

  await assert.rejects(pending, /spawn failed/);
  assert.equal(errors[0], failure);
});

test('dispose is idempotent, terminates the child, and rejects pending requests', async () => {
  const { transport, exits, children } = harness();
  assert.throws(() => transport.send({ method: 'before/start' }), /not started/);
  transport.start();
  const [fake] = children;
  const pending = transport.request('turn/start', {});

  transport.dispose();
  transport.dispose();

  await assert.rejects(pending, /disposed/);
  assert.deepEqual(fake.killSignals, ['SIGTERM']);
  assert.throws(() => transport.start(), /disposed/);
  assert.throws(() => transport.send({ method: 'after/dispose' }), /disposed/);

  fake.child.emit('close', 0, null);
  assert.deepEqual(exits, []);
});

// —— 下面两条来自变异运行：57 个变异存活 17 个，这两处是爆炸半径最大的。

// rejectPendingFor 的过滤条件反过来（`!==` 改成 `===`）后测试全绿。改反的后果是双向的：
// 离开的那个 runtime 的 pending 永不 settle（连同 context.runtime 的强引用一起泄漏，
// 正是这个方法上方注释要解决的问题），而**其它 runtime 正在飞的请求被误杀**。
test('rejectPendingFor rejects only the departing runtime and leaves other pending work alone', async () => {
  const h = harness();
  h.transport.start();
  const runtimeA = { name: 'a' };
  const runtimeB = { name: 'b' };

  const a = h.transport.request('m/a', {}, { context: { runtime: runtimeA } });
  const b = h.transport.request('m/b', {}, { context: { runtime: runtimeB } });

  let bSettled = null;
  b.then(value => { bSettled = { value }; }, error => { bSettled = { error }; });

  h.transport.rejectPendingFor(runtimeA, new Error('runtime detached'));

  await assert.rejects(a, /runtime detached/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bSettled, null, '拒绝 A 的 pending 不得连带 settle B 的');

  // B 的请求仍然活着，响应到达时正常兑现。
  const bFrame = jsonWrites(h.children[0]).find(frame => frame.method === 'm/b');
  h.children[0].child.stdout.emit('data',
    Buffer.from(`${JSON.stringify({ id: bFrame.id, result: { ok: true } })}\n`));
  assert.deepEqual(await b, { ok: true });

  h.transport.dispose();
});

// `child !== this.child || this.disposed` 这道守卫在四个方法里各有一份：handleStdout、
// handleStderr、handleChildError、handleChildExit。把任意一处的 `||` 改成 `&&` 后测试
// 都不红。改坏之后，一个已经被替换掉的旧子进程还能往当前 transport 里灌数据：它的
// stdout 会进 JSONL 解析器，它的 error/close 会把新起的 child 置 null 并拒绝所有在飞的
// 请求 —— 共享单进程架构下这一次打掉所有 runtime。
//
// ⚠ 这条刻意覆盖**全部四条通道**。先前的版本只测了 close 那一路，于是同族的另外三处
// 仍然裸着 —— 那正是 draft/TEST_PLAN.md §6 说的第四种假绿「形态漏过整族」，
// 只不过这次漏在测试侧。
test('every stale-child guard ignores a replaced child, not just the exit path', async () => {
  const stderrChunks = [];
  const h = harness({ onStderr: chunk => stderrChunks.push(chunk) });
  h.transport.start();
  const first = h.children[0];

  first.child.emit('close', 1, null);
  h.transport.start();
  const second = h.children[1];
  assert.equal(h.children.length, 2, '退出后显式重启应当起一个新子进程');

  const pending = h.transport.request('m/x', {});
  const before = {
    messages: h.messages.length,
    errors: h.errors.length,
    exits: h.exits.length,
    stderr: stderrChunks.length,
  };

  // 过期子进程的四条输入通道，一条都不该被当前 transport 采纳。
  first.child.stdout.emit('data', Buffer.from('{"method":"ghost/notify","params":{}}\n'));
  first.child.stderr.emit('data', Buffer.from('ghost stderr\n'));
  first.child.emit('error', new Error('ghost error'));
  first.child.emit('close', 9, 'SIGKILL');

  assert.equal(h.messages.length, before.messages, '过期子进程的 stdout 不得进入 JSONL 解析器');
  assert.equal(stderrChunks.length, before.stderr, '过期子进程的 stderr 不得被转发');
  assert.equal(h.errors.length, before.errors, '过期子进程的 error 不得上报');
  assert.equal(h.exits.length, before.exits, '过期子进程的退出不得再上报一次');

  // 当前子进程完好：在飞的请求照常兑现。
  const frame = jsonWrites(second).find(f => f.method === 'm/x');
  second.child.stdout.emit('data',
    Buffer.from(`${JSON.stringify({ id: frame.id, result: 'still alive' })}\n`));
  assert.equal(await pending, 'still alive', '过期子进程的事件不得拒绝新子进程上的 pending');

  h.transport.dispose();
});

// ---- 变异补漏：批 1 收尾（ROUTE） ----

// spawnImpl 的返回值校验有三个条件串在一起。任一个 || 变成 && 都会让一个残缺的子进程
// 通过这道闸，然后在下一行 `child.stdout.on(...)` 上炸成一句 TypeError——
// 而这道闸存在的全部意义，就是把"spawn 出来的东西不对"这件事说清楚，
// 而不是让它变成一句读不出原因的 "Cannot read properties of undefined"。
test('spawnImpl 返回残缺子进程时报出可读的原因，而不是在下一行炸成 TypeError', () => {
  const usable = () => {
    const { child } = fakeChild();
    return child;
  };

  const broken = [
    ['没有 stdin', () => { const c = usable(); delete c.stdin; return c; }],
    ['没有 stdout', () => { const c = usable(); delete c.stdout; return c; }],
    ['on 不是函数', () => { const c = usable(); c.on = undefined; return c; }],
    ['返回 null', () => null],
    ['返回一个空对象', () => ({})],
  ];

  for (const [label, spawnImpl] of broken) {
    const transport = new AppServerTransport({ codexBin: '/fake/codex', cwd: '/w', spawnImpl });
    assert.throws(() => transport.start(), /invalid app-server child/,
      `${label}：要说清是 spawnImpl 给的东西不对`);
    assert.equal(transport.child, null, `${label}：闸没过就不该把它记成当前子进程`);
  }
});

// start() 的返回值是调用方的子进程句柄——agent-appserver.js:142/167 直接
// `this.child = this.host.start()`。返回空的话，那边的 child 引用整个失效。
test('start 交回子进程句柄，重复调用交回同一个', () => {
  const fake = fakeChild();
  const transport = new AppServerTransport({
    codexBin: '/fake/codex', cwd: '/w', spawnImpl: () => fake.child,
  });

  const first = transport.start();
  assert.equal(first, fake.child, 'start 必须把子进程交回给调用方');
  assert.equal(transport.start(), first, '已经起来了就交回同一个，不重复 spawn');
  assert.equal(transport.child, first);
  transport.dispose();
});

// 子进程死掉时，stdout 里可能还剩最后一行**没有换行符**的内容——那往往正是
// 「它为什么死」的那条消息（错误响应、最后一个事件）。收尾不冲刷缓冲，这条消息就没了，
// 而调用方看到的是一个没有任何解释的退出。
test('子进程退出时冲刷 stdout 里最后一行没换行的内容', () => {
  const { transport, messages, children } = harness();
  transport.start();
  const [fake] = children;

  // 前一条完整（带换行），最后一条被进程死亡截断在换行之前。
  fake.child.stdout.emit('data', Buffer.from('{"method":"a/first","params":{}}\n'));
  fake.child.stdout.emit('data', Buffer.from('{"method":"a/last","params":{}}'));
  fake.child.emit('close', 1, null);

  assert.deepEqual(messages.map(message => message.method), ['a/first', 'a/last'],
    '最后那条没换行的消息必须在退出时被冲刷出来，不能随进程一起丢掉');
});

test('退出时缓冲里只有空白则不冲刷，不产生一条空消息', () => {
  const { transport, messages, children } = harness();
  transport.start();
  const [fake] = children;

  fake.child.stdout.emit('data', Buffer.from('{"method":"a/only","params":{}}\n   \n  '));
  fake.child.emit('close', 0, null);

  assert.deepEqual(messages.map(message => message.method), ['a/only'],
    '尾部只剩空白时不该再造一条消息出来');
});

// isResponse 决定一帧走「兑现某个 pending 请求」还是「交给 onMessage 当服务端消息」。
// 判错的两个方向后果都很实：把服务端**请求**（有 id、有 method、没有 result/error）
// 当成响应，它就再也到不了 onMessage——审批这类需要人回答的请求全部石沉大海；
// 反过来把响应当成消息，发出去的请求就永远不会兑现。
test('带 id 的服务端请求交给 onMessage，不当成某个请求的响应', () => {
  const { transport, messages, children } = harness();
  transport.start();
  const [fake] = children;

  const pending = transport.request('thread/list', {});
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });

  // 服务端请求：有 id、有 method，**没有** result/error。
  fake.child.stdout.emit('data', Buffer.from(
    '{"id":9001,"method":"item/commandExecution/requestApproval","params":{}}\n'));

  assert.deepEqual(messages.map(message => message.method),
    ['item/commandExecution/requestApproval'], '服务端请求要交给 onMessage');
  assert.equal(settled, false, '它不该被当成 thread/list 的响应');

  // 真正的响应（有 result）才兑现 pending。
  const sent = fake.writes.map(chunk => JSON.parse(chunk)).find(frame => frame.method === 'thread/list');
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: sent.id, result: { ok: true } })}\n`));
  transport.dispose();
  return pending.then(result => assert.deepEqual(result, { ok: true }));
});

test('一行 JSON null 不会把传输层炸掉', () => {
  const { transport, messages, errors, children } = harness();
  transport.start();
  const [fake] = children;

  fake.child.stdout.emit('data', Buffer.from('null\n{"method":"a/after","params":{}}\n'));

  assert.deepEqual(messages.filter(Boolean).map(message => message.method), ['a/after'],
    'null 那行不该阻断它后面的消息');
  assert.deepEqual(errors, [], '也不该被当成传输层错误报出去');
  transport.dispose();
});
