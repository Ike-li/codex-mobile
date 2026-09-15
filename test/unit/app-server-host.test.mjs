import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AppServerHost } from '../../app-server-host.js';
import { ThreadRegistry } from '../../thread-registry.js';
import { childEnv } from '../../app-server-transport.js';

// 等一个只由 unref 定时器驱动的 promise 时，必须有东西吊着事件循环。
// 请求超时定时器在生产代码里是 unref 的（线上有 HTTP listener 吊着，无影响），测试里没有，
// 于是事件循环先排空，node --test 判定「promise 仍挂起而事件循环已结束」，把用例标成
// cancelled——而 cancelled 不计入 fail，汇总看起来像通过。docs/TESTING.md 记过
// app-server-transport.test.mjs 那 4 条就是这个病，当时只修了那个文件、解法没传过来，
// 于是这里自 0fcfb72 引入那条超时用例起 CI 每次必红（不是间歇，是确定性的）。
// 那边有一份同源实现：test/ 下的用例彼此不 import，两处各自保持自包含。
async function withLiveEventLoop(fn) {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
}

function fakeChild() {
  const child = new EventEmitter();
  const writes = [];
  const killSignals = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write(chunk) {
      writes.push(JSON.parse(String(chunk)));
      return true;
    },
  };
  child.kill = signal => {
    killSignals.push(signal);
    return true;
  };
  return { child, writes, killSignals };
}

function runtime(instanceId) {
  const frames = [];
  const exits = [];
  const errors = [];
  return {
    instanceId,
    frames,
    exits,
    errors,
    observeTransportFrame() {},
    handleFrame(frame) { frames.push(frame); },
    handleTransportExit(detail) { exits.push(detail); },
    handleTransportError(error) { errors.push(error); },
  };
}

test('one host initializes its app-server connection only once for multiple runtimes', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-a');
  const runtimeB = runtime('inst-b');
  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  host.attach(runtimeA);
  host.attach(runtimeB);

  const initializedA = host.ensureInitialized(runtimeA);
  const initializedB = host.ensureInitialized(runtimeB);
  assert.equal(fake.writes.filter(frame => frame.method === 'initialize').length, 1);

  const initialize = fake.writes.find(frame => frame.method === 'initialize');
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: initialize.id, result: {} })}\n`));
  await Promise.all([initializedA, initializedB]);

  assert.deepEqual(fake.writes.map(frame => frame.method), ['initialize', 'initialized']);
  host.dispose();
});

test('failed host initialization resets the single-flight so a later call can retry', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-a');
  registry.register(owner, { instanceId: 'inst-a', threadId: 'thr-a' });
  host.attach(owner);

  const first = host.ensureInitialized(owner);
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"error":{"code":-32000,"message":"init failed"}}\n'));
  await assert.rejects(first, /init failed/);

  const second = host.ensureInitialized(owner);
  assert.equal(fake.writes.filter(frame => frame.method === 'initialize').length, 2);
  fake.child.stdout.emit('data', Buffer.from('{"id":2,"result":{}}\n'));
  await second;
  host.dispose();
});

test('shared host routes a notification only to the runtime owning its thread', () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-a');
  const runtimeB = runtime('inst-b');
  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  registry.bind(runtimeB, { turnId: 'turn-b' });
  host.attach(runtimeA);
  host.attach(runtimeB);
  host.start();

  const notification = {
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr-b', turnId: 'turn-b', itemId: 'item-b', delta: 'B' },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(notification)}\n`));

  assert.deepEqual(runtimeA.frames, []);
  assert.deepEqual(runtimeB.frames, [notification]);
  host.dispose();
});

test('host binds a turn from its response before routing the next frame in the same stdout chunk', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-a');
  registry.register(owner, { instanceId: 'inst-a', threadId: 'thr-a' });

  const started = host.request(owner, 'turn/start', { threadId: 'thr-a', input: [] });
  const delta = {
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr-a', turnId: 'turn-a', itemId: 'item-a', delta: 'R' },
  };
  fake.child.stdout.emit('data', Buffer.from(
    `${JSON.stringify({ id: 1, result: { turn: { id: 'turn-a' } } })}\n${JSON.stringify(delta)}\n`,
  ));
  await started;

  assert.equal(registry.resolve({ threadId: 'thr-a', turnId: 'turn-a' }), owner);
  assert.deepEqual(owner.frames, [delta]);
  host.dispose();
});

test('host correlates account login notifications back to the requesting runtime', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-login');
  registry.register(owner, { instanceId: 'inst-login' });
  host.attach(owner);

  const start = host.request(owner, 'account/login/start', { type: 'chatgptDeviceCode' });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"type":"chatgptDeviceCode","loginId":"login-a"}}\n'));
  await start;
  const completed = {
    method: 'account/login/completed',
    params: { loginId: 'login-a', success: true, error: null },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(completed)}\n`));

  assert.deepEqual(owner.frames, [completed]);
  host.dispose();
});

test('host routes account state updates to the runtime that owns the login flow', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-account');
  registry.register(owner, { instanceId: 'inst-account' });

  const start = host.request(owner, 'account/login/start', { type: 'chatgptDeviceCode' });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"type":"chatgptDeviceCode","loginId":"login-account"}}\n'));
  await start;
  const updated = {
    method: 'account/updated',
    params: { authMode: 'chatgpt', planType: 'plus' },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(updated)}\n`));

  assert.deepEqual(owner.frames, [updated]);
  host.dispose();
});

test('host routes a thread management notification when that thread has no live runtime', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-control');
  registry.register(owner, { instanceId: 'inst-control' });

  const compact = host.request(owner, 'thread/compact/start', { threadId: 'thr-unloaded' });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{}}\n'));
  await compact;
  const notification = {
    method: 'thread/compacted',
    params: { threadId: 'thr-unloaded', turnId: 'turn-compact' },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(notification)}\n`));

  assert.deepEqual(owner.frames, [notification]);
  host.dispose();
});

test('host routes thread compaction to its loaded thread owner before the turn is bound', () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-compact');
  registry.register(owner, { instanceId: 'inst-compact', threadId: 'thr-compact' });
  host.attach(owner);
  host.start();

  const notification = {
    method: 'thread/compacted',
    params: { threadId: 'thr-compact', turnId: 'turn-not-yet-bound' },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(notification)}\n`));

  assert.deepEqual(owner.frames, [notification]);
  host.dispose();
});

test('host publishes status for an unloaded thread without routing it to a control runtime', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const statuses = [];
  const unrouted = [];
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
    onThreadStatus: status => statuses.push(status),
    onUnrouted: frame => unrouted.push(frame),
  });
  const control = runtime('inst-control');
  registry.register(control, { instanceId: 'inst-control' });

  const read = host.request(control, 'thread/read', { threadId: 'thr-unloaded' });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"thread":{"id":"thr-unloaded"}}}\n'));
  await read;
  const notification = {
    method: 'thread/status/changed',
    params: { threadId: 'thr-unloaded', status: { type: 'active', activeFlags: [] } },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(notification)}\n`));

  assert.deepEqual(control.frames, []);
  assert.deepEqual(statuses, [{
    threadId: 'thr-unloaded',
    status: { type: 'active', activeFlags: [] },
    revision: 1,
  }]);
  assert.deepEqual(unrouted, []);
  assert.deepEqual(registry.snapshot().map(record => ({
    instanceId: record.instanceId,
    threadId: record.threadId,
  })), [{ instanceId: 'inst-control', threadId: null }]);
  host.dispose();
});

test('host thread status revisions stay monotonic across child restarts', () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });

  const first = host.publishThreadStatus({
    method: 'thread/status/changed',
    params: { threadId: 'thr-status', status: { type: 'active', activeFlags: [] } },
  });
  const second = host.publishThreadStatus({
    method: 'thread/status/changed',
    params: { threadId: 'thr-status', status: { type: 'idle' } },
  });
  host.handleExit({ code: 1, signal: null });
  const afterRestart = host.publishThreadStatus({
    method: 'thread/status/changed',
    params: { threadId: 'thr-status', status: { type: 'systemError' } },
  });

  assert.deepEqual(
    [first.revision, second.revision, afterRestart.revision],
    [1, 2, 3],
  );
  host.dispose();
});

test('host routes terminal output by processId to the runtime that spawned it', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-terminal');
  registry.register(owner, { instanceId: 'inst-terminal' });

  const command = host.request(owner, 'command/exec', {
    processId: 'process-a',
    command: ['echo', 'private'],
  });
  const output = {
    method: 'command/exec/outputDelta',
    params: { processId: 'process-a', stream: 'stdout', deltaBase64: 'cHJpdmF0ZQ==' },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(output)}\n`));
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"exitCode":0}}\n'));
  await command;

  assert.deepEqual(owner.frames, [output]);
  host.dispose();
});

test('host rejects a processId collision until the owning process exits', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-terminal-a');
  const runtimeB = runtime('inst-terminal-b');
  registry.register(runtimeA, { instanceId: runtimeA.instanceId });
  registry.register(runtimeB, { instanceId: runtimeB.instanceId });

  const first = host.request(runtimeA, 'command/exec', {
    processId: 'shared-process',
    command: ['sleep', '1'],
  });
  const firstFrame = fake.writes.at(-1);
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: firstFrame.id, result: {} })}\n`));
  await first;

  await assert.rejects(
    host.request(runtimeB, 'command/exec', {
      processId: 'shared-process',
      command: ['echo', 'wrong-owner'],
    }, { timeoutMs: 10 }),
    /already owned/,
  );
  assert.equal(fake.writes.filter(frame => frame.method === 'command/exec').length, 1);

  const exited = {
    method: 'process/exited',
    params: { processId: 'shared-process', exitCode: 0 },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(exited)}\n`));
  const second = host.request(runtimeB, 'command/exec', {
    processId: 'shared-process',
    command: ['echo', 'new-owner'],
  });
  const secondFrame = fake.writes.at(-1);
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: secondFrame.id, result: {} })}\n`));
  await second;

  assert.equal(fake.writes.filter(frame => frame.method === 'command/exec').length, 2);
  assert.deepEqual(runtimeA.frames, [exited]);
  assert.deepEqual(runtimeB.frames, []);
  host.dispose();
});

test('host routes remote-control status to the runtime requesting experimental capabilities', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-experimental');
  registry.register(owner, { instanceId: 'inst-experimental' });

  const capabilities = host.request(owner, 'experimentalFeature/list', {});
  const status = {
    method: 'remoteControl/status/changed',
    params: { status: { type: 'connected' }, serverName: 'local' },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(status)}\n`));
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"data":[]}}\n'));
  await capabilities;

  assert.deepEqual(owner.frames, [status]);
  host.dispose();
});

test('host rejects an unrouted unknown server request instead of leaving app-server hung', () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  host.start();

  fake.child.stdout.emit('data', Buffer.from('{"id":77,"method":"unknown/request","params":{}}\n'));

  assert.deepEqual(fake.writes, [{
    id: 77,
    error: { code: -32601, message: 'Unsupported server request: unknown/request' },
  }]);
  host.dispose();
});

test('host rejects a targeted approval request when no runtime owns its identifiers', () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  host.start();

  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({
    id: 88,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'missing-thread', turnId: 'missing-turn', itemId: 'missing-item' },
  })}\n`));

  assert.deepEqual(fake.writes, [{
    id: 88,
    error: {
      code: -32602,
      message: 'No runtime owns server request: item/commandExecution/requestApproval',
    },
  }]);
  host.dispose();
});

test('host routes a legacy approval by its stable conversationId alias', () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const owner = runtime('inst-legacy-approval');
  registry.register(owner, { instanceId: owner.instanceId, threadId: 'thr-legacy-approval' });
  host.attach(owner);
  host.start();

  const request = {
    id: 88,
    method: 'applyPatchApproval',
    params: {
      conversationId: 'thr-legacy-approval',
      callId: 'patch-call',
      fileChanges: {},
      reason: 'write files',
      grantRoot: null,
    },
  };
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify(request)}\n`));

  assert.deepEqual(owner.frames, [request]);
  assert.deepEqual(fake.writes, []);
  host.dispose();
});

test('host drops a frame whose thread and turn identifiers belong to different runtimes', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-a');
  const runtimeB = runtime('inst-b');
  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtimeA, { turnId: 'turn-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  registry.bind(runtimeB, { turnId: 'turn-b' });

  const request = host.request(runtimeA, 'turn/start', { threadId: 'thr-a', input: [] });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"turn":{"id":"turn-a"}}}\n'));
  await request;
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr-a', turnId: 'turn-b', itemId: 'foreign', delta: 'must drop' },
  })}\n`));

  assert.deepEqual(runtimeA.frames, []);
  assert.deepEqual(runtimeB.frames, []);
  host.dispose();
});

test('detaching one runtime does not terminate the shared process used by another', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-a');
  const runtimeB = runtime('inst-b');
  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  host.attach(runtimeA);
  host.attach(runtimeB);
  host.start();

  assert.equal(host.detach(runtimeA), true);
  assert.deepEqual(fake.killSignals, []);
  const request = host.request(runtimeB, 'thread/read', { threadId: 'thr-b' });
  fake.child.stdout.emit('data', Buffer.from('{"id":1,"result":{"thread":{"id":"thr-b"}}}\n'));
  await request;

  host.dispose();
  assert.deepEqual(fake.killSignals, ['SIGTERM']);
});

test('shared process exit notifies every attached runtime exactly once', () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-a');
  const runtimeB = runtime('inst-b');
  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  host.attach(runtimeA);
  host.attach(runtimeB);
  host.start();

  fake.child.emit('close', 7, 'SIGTERM');

  assert.deepEqual(runtimeA.exits, [{ code: 7, signal: 'SIGTERM' }]);
  assert.deepEqual(runtimeB.exits, [{ code: 7, signal: 'SIGTERM' }]);
  assert.deepEqual(runtimeA.errors, []);
  assert.deepEqual(runtimeB.errors, []);
  host.dispose();
});

test('thread status cache does not grow without bound', () => {
  // threadStatuses 只在 transport 退出/出错/dispose 时整体 clear，每个被 app-server
  // 报过状态的 thread 留一条，跑几天单调增长。
  const fake = fakeChild();
  const host = new AppServerHost({ registry: new ThreadRegistry(), spawnImpl: () => fake.child });
  for (let index = 0; index < 2000; index += 1) {
    host.handleMessage({
      method: 'thread/status/changed',
      params: { threadId: `thr_${index}`, status: { type: 'idle' } },
    });
  }
  assert.ok(host.threadStatuses.size <= 512, `状态缓存涨到 ${host.threadStatuses.size} 条`);
  host.dispose();
});

test('thread status cache keeps the most recently seen threads', () => {
  const fake = fakeChild();
  const host = new AppServerHost({ registry: new ThreadRegistry(), spawnImpl: () => fake.child });
  for (let index = 0; index < 600; index += 1) {
    host.handleMessage({
      method: 'thread/status/changed',
      params: { threadId: `thr_${index}`, status: { type: 'idle' } },
    });
    // 让 thr_0 一直保持活跃
    host.handleMessage({
      method: 'thread/status/changed',
      params: { threadId: 'thr_0', status: { type: 'active' } },
    });
  }
  assert.ok(host.latestThreadStatus('thr_0'), '一直在更新的 thread 不该被挤掉');
  host.dispose();
});

// 测试框架的控制变量不属于业务环境：NODE_TEST_CONTEXT 会让子进程里的 node:test 以为自己
// 是测试子进程，NODE_OPTIONS 会把预加载脚本带进去。codex 仍需继承 PATH / CODEX_HOME /
// 上游配置，所以只剔除这几个，不做白名单。
test('spawn 给 codex 的环境剔除测试框架控制变量，保留业务配置', () => {
  const env = childEnv({
    PATH: '/usr/bin',
    CODEX_HOME: '/home/u/.codex',
    OPENAI_BASE_URL: 'https://upstream.example/v1',
    NODE_TEST_CONTEXT: 'child-v8',
    NODE_TEST_WORKER_ID: '1',
    NODE_CHANNEL_FD: '3',
    NODE_OPTIONS: '--import file:///tmp/x.mjs',
  });
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    CODEX_HOME: '/home/u/.codex',
    OPENAI_BASE_URL: 'https://upstream.example/v1',
  });
});

// —— 下面几条来自一次变异运行：157 个变异存活 75 个，resolveInboundOwner 是重灾区。
// 它是 ROUTE-03 的实现（无法唯一定位 owner 就 fail-closed），下面补的是它三条
// 完全没有断言盯着的路径。

// 把 `typeof turnId !== 'string' || !turnId` 改成 `&&` 后测试仍绿 —— 说明「有 thread、
// 没有可用 turn」这条路没人测。它是最常见的形态：thread 级通知本来就不带 turnId。
test('a frame with a thread but no usable turn id still reaches the thread owner', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex', cwd: '/workspace', registry, spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-a');
  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  host.attach(runtimeA);
  host.start();

  for (const turnId of [undefined, '', null, 42]) {
    fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thr-a', turnId, itemId: 'i1', delta: 'x' },
    })}\n`));
  }

  assert.equal(runtimeA.frames.length, 4,
    'turnId 缺失或不是非空字符串时，应当退回按 thread 路由，而不是丢帧');
  host.dispose();
});

// `turn/started` 带来一个 registry 还不认识的 turn：thread owner 若尚未绑定任何 turn，
// 就该收下并绑上。改坏 :267 / :268 / :270 任意一处测试都不红，说明这条「首次见到 turn」
// 的路径完全没有覆盖——而它是每一轮对话的第一帧。
test('turn/started binds an unseen turn to a thread owner that has none', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex', cwd: '/workspace', registry, spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-a');
  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  host.attach(runtimeA);
  host.start();

  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({
    method: 'turn/started',
    params: { threadId: 'thr-a', turnId: 'turn-new' },
  })}\n`));

  assert.equal(runtimeA.frames.length, 1, 'turn/started 必须送达 thread owner');
  assert.equal(registry.resolve({ threadId: 'thr-a', turnId: 'turn-new' }), runtimeA,
    '收下之后要把 turn 绑到 registry 上，否则后续同 turn 的帧又会走一遍这条兜底路径');
  host.dispose();
});

// 反面：thread owner 已经在跑另一个 turn 时，陌生 turn 的 turn/started 不得被收下。
// 收下就意味着一个 runtime 同时拥有两个 turn，后续两轮的输出会串在一起。
test('turn/started for a foreign turn is dropped when the owner is busy with another', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex', cwd: '/workspace', registry, spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-a');
  runtimeA.currentTurnId = 'turn-running';
  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  host.attach(runtimeA);
  host.start();

  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({
    method: 'turn/started',
    params: { threadId: 'thr-a', turnId: 'turn-other' },
  })}\n`));

  assert.deepEqual(runtimeA.frames, [],
    'owner 正忙于另一个 turn 时，陌生 turn 必须丢弃——收下会让两轮输出串流');
  host.dispose();
});

// 只带 turnId、不带 threadId 的帧：靠 turn 索引解析，解析不到就丢。
// :277 / :279 三个变异全存活，说明这两条分支都没有断言。
test('a frame carrying only a turn id resolves through the turn index', async () => {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex', cwd: '/workspace', registry, spawnImpl: () => fake.child,
  });
  const runtimeA = runtime('inst-a');
  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtimeA, { turnId: 'turn-a' });
  host.attach(runtimeA);
  host.start();

  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { turnId: 'turn-a', itemId: 'i1', delta: 'x' },
  })}\n`));
  fake.child.stdout.emit('data', Buffer.from(`${JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { turnId: 'turn-unknown', itemId: 'i2', delta: 'y' },
  })}\n`));

  assert.equal(runtimeA.frames.length, 1, '已知 turn 送达、未知 turn 丢弃');
  assert.equal(runtimeA.frames[0].params.itemId, 'i1');
  host.dispose();
});

// ---- 变异补漏：批 1 收尾（ROUTE） ----

function hostFixture({ experimentalApi } = {}) {
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const unrouted = [];
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
    onUnrouted: frame => unrouted.push(frame),
    ...(experimentalApi === undefined ? {} : { experimentalApi }),
  });
  return { host, registry, fake, unrouted };
}

// detach 要把这个 runtime 的所有权全部清掉——**只清它自己的**。
// 清成别人的，等于一个 runtime 退出就把还活着的那些的路由表擦了：
// 它们后续的事件全部变成「无人认领」，用户那边表现为消息停更而没有任何报错。
test('detach 只清掉这个 runtime 的所有权，不碰其它 runtime 的', () => {
  const { host, registry } = hostFixture();
  const runtimeA = runtime('inst-a');
  const runtimeB = runtime('inst-b');
  registry.register(runtimeA, { instanceId: 'inst-a' });
  registry.register(runtimeB, { instanceId: 'inst-b' });

  host.request(runtimeA, 'process/start', { processId: 'proc-a' }).catch(() => {});
  host.request(runtimeB, 'process/start', { processId: 'proc-b' }).catch(() => {});
  // channelOwners：account/* 的出站帧把 account 频道归给发起者。
  host.handleObservedFrame({
    direction: 'outbound',
    frame: { id: 9, method: 'account/login', params: {} },
    context: { runtime: runtimeB },
  });

  host.detach(runtimeA);

  host.handleMessage({ method: 'process/output', params: { processId: 'proc-b' } });
  assert.equal(runtimeB.frames.length, 1, 'B 的 processId 关联不该被 A 的 detach 波及');

  host.handleMessage({ method: 'account/status', params: {} });
  assert.equal(runtimeB.frames.length, 2, 'B 的 account 频道所有权同样不该被波及');

  host.handleMessage({ method: 'process/output', params: { processId: 'proc-a' } });
  assert.equal(runtimeA.frames.length, 0, 'A 已经 detach，它的关联必须真的被清掉');
  host.dispose();
});

// 关联键的统一契约：**只有非空字符串才能成为键**。
// 破坏它的后果是跨 runtime 串台——把 123 写进 `thread:123`，另一个 runtime 发来
// 字符串 '123' 的帧就会命中同一个格子，一个人的事件被投递到另一个人的手机上。
const NOT_AN_ID = [
  ['数字', 123, '123'],
  ['null', null, 'null'],
  ['对象', {}, '[object Object]'],
  ['空串', '', ''],
];

test('出站帧里非字符串或空的标识符不得成为关联键', () => {
  const cases = [
    ['threadId', bad => ({
      direction: 'outbound',
      frame: { id: 1, method: 'thread/sendMessage', params: { threadId: bad } },
    }), asString => ({ method: 'thread/event', params: { threadId: asString } })],
    ['processId', bad => ({
      direction: 'outbound',
      frame: { id: 2, method: 'process/start', params: { processId: bad } },
    }), asString => ({ method: 'process/output', params: { processId: asString } })],
    ['loginId', bad => ({
      direction: 'inbound',
      frame: { id: 3, result: { loginId: bad } },
    }), asString => ({ method: 'account/loginUpdate', params: { loginId: asString } })],
  ];

  for (const [field, outbound, inbound] of cases) {
    for (const [label, bad, asString] of NOT_AN_ID) {
      const { host, registry, unrouted } = hostFixture();
      const rt = runtime('inst-a');
      registry.register(rt, { instanceId: 'inst-a' });
      host.attach(rt);

      host.handleObservedFrame({ ...outbound(bad), context: { runtime: rt } });
      host.handleMessage(inbound(asString));

      assert.deepEqual(rt.frames, [],
        `${field} 是${label}时不该建立关联；建立了就意味着另一个 runtime 的同名字符串帧会串到这里`);
      assert.equal(unrouted.length, 1, `${field} 是${label}：认不出归属的入站帧要被报为未路由`);
      host.dispose();
    }
  }
});

// 读取侧同样要求非空字符串。写入侧和读取侧任何一边失守，都足以造成串台，
// 所以两边都要有断言——只测一边时，另一边被改坏仍然全绿。
test('入站帧里非字符串或空的标识符不参与归属解析', () => {
  for (const [label, bad] of NOT_AN_ID) {
    const { host, registry, unrouted } = hostFixture();
    const rt = runtime('inst-a');
    registry.register(rt, { instanceId: 'inst-a', threadId: 'thr-real' });
    host.attach(rt);

    for (const params of [{ threadId: bad }, { processId: bad }, { loginId: bad }, { turnId: bad }]) {
      host.handleMessage({ method: 'thread/event', params });
    }

    assert.deepEqual(rt.frames, [], `${label}：不该被解析成任何 runtime 的帧`);
    assert.equal(unrouted.length, 4, `${label}：四帧都该被报为未路由`);
    host.dispose();
  }
});

// thread/status/changed 的四个前提缺一不可。少了任何一个就发布，
// 订阅方会收到一条 threadId 为空或 status 不是对象的状态变更，
// 而状态是驱动手机上「运行中 / 空闲」显示的东西。
test('线程状态发布要求 threadId 是非空字符串且 status 是对象，四个前提缺一不可', () => {
  const published = [];
  const fake = fakeChild();
  const registry = new ThreadRegistry();
  const host = new AppServerHost({
    codexBin: '/fake/codex',
    cwd: '/workspace',
    registry,
    spawnImpl: () => fake.child,
    onThreadStatus: change => published.push(change),
  });

  const rejected = [
    ['threadId 不是字符串', { threadId: 123, status: { state: 'running' } }],
    ['threadId 是空串', { threadId: '', status: { state: 'running' } }],
    ['没有 status', { threadId: 'thr-1' }],
    ['status 不是对象', { threadId: 'thr-1', status: 'running' }],
  ];
  for (const [label, params] of rejected) {
    assert.equal(host.publishThreadStatus({ method: 'thread/status/changed', params }), null, label);
  }
  assert.deepEqual(published, [], '被拒的都不该发布出去');

  const change = host.publishThreadStatus({
    method: 'thread/status/changed',
    params: { threadId: 'thr-1', status: { state: 'running' } },
  });
  assert.equal(change.threadId, 'thr-1');
  assert.deepEqual(published.map(item => item.threadId), ['thr-1'], '四个前提齐了就要发布');
  host.dispose();
});

// initialize 里声明的能力必须和实际实现一致：多声明一个没实现的能力，
// 服务端会按那个能力发协议帧过来，而本端不认识——表现为随机的协议错误。
test('initialize 声明的能力如实反映配置，不多声明没实现的那个', () => {
  for (const [label, option, expected] of [
    ['默认不开实验 API', undefined, false],
    ['显式开启', true, true],
    ['显式关闭', false, false],
    ['给了个非 true 的值也算关闭', 'yes', false],
  ]) {
    const { host, registry, fake } = hostFixture({ experimentalApi: option });
    const rt = runtime('inst-a');
    registry.register(rt, { instanceId: 'inst-a' });
    host.ensureInitialized(rt).catch(() => {});

    const initialize = fake.writes.find(frame => frame.method === 'initialize');
    assert.equal(initialize.params.capabilities.experimentalApi, expected, label);
    assert.equal(initialize.params.capabilities.requestAttestation, false,
      'attestation 本端没实现，声明成 true 会让服务端按它发帧过来');
    host.dispose();
  }
});

// attach 的三条边界。中间那条带着一段注释解释过的事故：已 dispose 的 runtime 被
// ensureInitialized 的 await 解开后重新塞回 runtimes，而 detach 不会再发生第二次，于是永久泄漏。
test('attach 拒绝空 runtime 与已 dispose 的 host，也不收回已 dispose 的 runtime', () => {
  const { host, registry } = hostFixture();
  const live = runtime('inst-live');
  live.disposed = false;
  const dead = runtime('inst-dead');
  dead.disposed = true;
  registry.register(live, { instanceId: 'inst-live' });

  assert.throws(() => host.attach(null), /disposed host/, '空 runtime 要有明确的报错');
  assert.equal(host.attach(live), live, 'attach 回传传进来的那个 runtime');

  host.attach(dead);
  host.handleExit({ code: 0 });
  assert.equal(live.exits.length, 1, '活着的 runtime 要收到退出通知');
  assert.equal(dead.exits.length, 0, '已 dispose 的 runtime 不该被收回 runtimes，否则永久泄漏');

  host.dispose();
  assert.throws(() => host.attach(live), /disposed host/, 'dispose 之后不能再 attach');
});

// 子进程还活着时的 transport 错误是瞬时的，不该把整套状态清掉、也不该通知 runtime 退出。
// 清早了的后果是：连接其实还在，但所有关联被抹掉，后续事件全变成无人认领。
test('子进程仍然活着时的 transport 错误不清空路由状态', () => {
  const { host, registry, fake } = hostFixture();
  const rt = runtime('inst-a');
  registry.register(rt, { instanceId: 'inst-a' });
  host.request(rt, 'process/start', { processId: 'proc-a' }).catch(() => {});
  assert.ok(fake.child, '前置：子进程已经起来了');

  host.handleError(new Error('瞬时错误'));

  assert.equal(rt.errors.length, 0, '子进程还在，不该通知 runtime 出错');
  host.handleMessage({ method: 'process/output', params: { processId: 'proc-a' } });
  assert.equal(rt.frames.length, 1, '关联必须还在');
  host.dispose();
});

// respond / respondError 在没有子进程时要如实返回 false，让调用方知道这次没发出去。
test('没有子进程时 respond 与 respondError 返回 false，有子进程时返回真值', () => {
  const { host, registry, fake } = hostFixture();
  const rt = runtime('inst-a');
  registry.register(rt, { instanceId: 'inst-a' });
  host.attach(rt);

  assert.equal(host.respond(rt, 1, {}), false, '还没起子进程，答复发不出去');
  assert.equal(host.respondError(rt, 1, -32601, 'nope'), false);

  host.start();
  assert.equal(host.respond(rt, 2, { ok: true }), true, '子进程在，答复应当真的发出去');
  assert.equal(host.respondError(rt, 3, -32601, 'nope'), true);
  assert.equal(fake.writes.filter(frame => frame.id === 2 || frame.id === 3).length, 2);
  host.dispose();
});

// thread/status/changed 走的是一条独立的解析分支（只认 threadId，不看 turnId）。
// 它必须投递给拥有该线程的 runtime——判错了，手机上的「运行中 / 空闲」就不再更新。
test('thread/status/changed 投递给拥有该线程的 runtime', () => {
  const { host, registry, unrouted } = hostFixture();
  const rt = runtime('inst-a');
  registry.register(rt, { instanceId: 'inst-a', threadId: 'thr-1' });
  host.attach(rt);

  host.handleMessage({
    method: 'thread/status/changed',
    params: { threadId: 'thr-1', status: { state: 'running' } },
  });

  assert.equal(rt.frames.length, 1, '状态变更要送到线程的归属 runtime');
  assert.deepEqual(unrouted, [], '认得出归属就不该报未路由');
  host.dispose();
});

// 响应帧是归属的**建立**时机：thread/start 与 thread/resume 的结果带回 threadId，
// turn/start 与 turn/steer 的结果带回 turnId。少认一个方法，那条路径上的后续事件全部无人认领。
test('thread/start·thread/resume·turn/start·turn/steer 的响应各自建立归属', () => {
  const bindings = [
    ['thread/start', { thread: { id: 'thr-start' } }, { threadId: 'thr-start' }],
    ['thread/resume', { thread: { id: 'thr-resume' } }, { threadId: 'thr-resume' }],
    ['turn/start', { turn: { id: 'turn-start' } }, { turnId: 'turn-start' }],
    ['turn/steer', { turn: { id: 'turn-steer' } }, { turnId: 'turn-steer' }],
  ];

  for (const [method, result, lookup] of bindings) {
    const { host, registry } = hostFixture();
    const rt = runtime('inst-a');
    registry.register(rt, { instanceId: 'inst-a' });
    host.attach(rt);

    host.handleObservedFrame({
      direction: 'inbound',
      method,
      frame: { id: 1, result },
      context: { runtime: rt },
    });

    assert.equal(registry.resolve(lookup), rt, `${method} 的响应必须把归属登记进 registry`);
    host.dispose();
  }
});

// loginId 是最优先的线索（登录流程跨线程、没有 threadId 可用）。两件事都要成立：
// 认得出时按它投递；认不出时**不能就地返回 null**，否则后面的 threadId 线索就废了。
test('loginId 归属优先，但查不到时不阻断后续线索', () => {
  const { host, registry } = hostFixture();
  const rt = runtime('inst-a');
  registry.register(rt, { instanceId: 'inst-a', threadId: 'thr-1' });
  host.attach(rt);

  host.handleObservedFrame({
    direction: 'inbound',
    method: 'account/login',
    frame: { id: 1, result: { loginId: 'login-1' } },
    context: { runtime: rt },
  });

  host.handleMessage({ method: 'account/loginUpdate', params: { loginId: 'login-1' } });
  assert.equal(rt.frames.length, 1, '认得出的 loginId 要按它投递');

  // 陌生 loginId + 认得出的 threadId：必须继续往下解析，而不是停在 loginId 这一步。
  host.handleMessage({ method: 'thread/event', params: { loginId: 'login-unknown', threadId: 'thr-1' } });
  assert.equal(rt.frames.length, 2, 'loginId 查不到时要继续用 threadId 解析');
  host.dispose();
});

// 一个畸形的 threadId 不该把整帧判死：turnId 那条线索还在。
// 停在 threadId 这一步的后果是——带坏 threadId 的 turn 事件全部丢失，而 turn 是正在跑的那个。
test('threadId 畸形时仍然按 turnId 解析，不就地判死', () => {
  const { host, registry } = hostFixture();
  const rt = runtime('inst-a');
  registry.register(rt, { instanceId: 'inst-a', threadId: 'thr-1' });
  registry.bind(rt, { turnId: 'turn-9' });
  host.attach(rt);

  host.handleMessage({ method: 'turn/event', params: { threadId: 123, turnId: 'turn-9' } });
  assert.equal(rt.frames.length, 1, 'threadId 不可用时 turnId 仍然是有效线索');
  host.dispose();
});

// turn/started 携带的是一个还没登记过的 turnId。线程的归属方当前空闲时，
// 要就地把这个 turn 绑给它并投递——否则一个 turn 的全部事件都无人认领。
test('turn/started 为已知线程登记新轮次并投递给线程的归属方', () => {
  const { host, registry } = hostFixture();
  const rt = runtime('inst-a');
  registry.register(rt, { instanceId: 'inst-a', threadId: 'thr-1' });
  host.attach(rt);

  host.handleMessage({ method: 'turn/started', params: { threadId: 'thr-1', turnId: 'turn-new' } });

  assert.equal(rt.frames.length, 1, 'turn/started 要投递给线程的归属方');
  assert.equal(registry.resolve({ turnId: 'turn-new' }), rt, '并且把这个轮次登记下来');
  host.dispose();
});

// 没有 context 的响应帧（transport 认不出是谁发的）不得篡改任何归属。
// 把 null 写进 channelOwners / registry 的后果是：原来正确的归属被抹掉，
// 该 runtime 后续的事件集体变成无人认领。
test('没有归属的响应帧不得篡改任何归属', () => {
  const { host, registry } = hostFixture();
  const rt = runtime('inst-a');
  registry.register(rt, { instanceId: 'inst-a' });
  host.attach(rt);

  // 先建立正确的 account 频道归属。
  host.handleObservedFrame({
    direction: 'outbound',
    frame: { id: 1, method: 'account/login', params: {} },
    context: { runtime: rt },
  });
  host.handleMessage({ method: 'account/status', params: {} });
  assert.equal(rt.frames.length, 1, '前置：account 频道归 rt');

  // 无 context 的入站响应帧：既不该建立线程归属，也不该把频道归属改掉。
  host.handleObservedFrame({
    direction: 'inbound',
    method: 'thread/start',
    frame: { id: 2, result: { thread: { id: 'thr-ghost' } } },
  });
  host.handleObservedFrame({
    direction: 'inbound',
    frame: { id: 3, method: 'account/whatever', result: {} },
  });

  assert.throws(() => registry.resolve({ threadId: 'thr-ghost' }),
    '认不出发起方的响应不得登记线程归属');
  host.handleMessage({ method: 'account/status', params: {} });
  assert.equal(rt.frames.length, 2, 'account 频道的归属不该被无主帧抹掉');
  host.dispose();
});

// 带 id 的**服务端请求**（有 method、没有 result/error）不是响应，要按 params 解析归属。
// 判成响应的话它会走进"按 context 找发起方"那条路，而服务端请求根本没有 context——
// 结果是每一个服务端请求都无人认领，审批这类需要人回答的请求全部石沉大海。
test('带 id 的服务端请求不是响应，仍按 params 解析归属', () => {
  const { host, registry, unrouted } = hostFixture();
  const rt = runtime('inst-a');
  registry.register(rt, { instanceId: 'inst-a', threadId: 'thr-1' });
  host.attach(rt);

  const frame = { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thr-1' } };
  host.handleObservedFrame({ direction: 'inbound', method: frame.method, frame });

  assert.deepEqual(unrouted, [],
    '有 id 但没有 result/error 的是服务端请求，不是响应；判成响应就会按 context 找发起方而找不到');
  host.handleMessage(frame);
  assert.equal(rt.frames.length, 1, '服务端请求要按 params.threadId 投递给归属方');
  host.dispose();
});

// 出站帧里的 processId 建立关联；入站帧里的不建立（那是别人的进程，不是我们发起的）。
test('processId 关联只从出站帧建立', () => {
  const { host, registry, unrouted } = hostFixture();
  const rt = runtime('inst-a');
  registry.register(rt, { instanceId: 'inst-a' });
  host.attach(rt);

  host.handleObservedFrame({
    direction: 'outbound',
    frame: { id: 1, method: 'process/start', params: { processId: 'proc-out' } },
    context: { runtime: rt },
  });
  host.handleMessage({ method: 'process/output', params: { processId: 'proc-out' } });
  assert.equal(rt.frames.length, 1, '出站帧建立的关联要生效');

  const { host: host2, registry: registry2, unrouted: unrouted2 } = hostFixture();
  const rt2 = runtime('inst-b');
  registry2.register(rt2, { instanceId: 'inst-b' });
  host2.attach(rt2);
  host2.handleObservedFrame({
    direction: 'inbound',
    frame: { id: 2, result: {}, params: { processId: 'proc-in' } },
    context: { runtime: rt2 },
  });
  host2.handleMessage({ method: 'process/output', params: { processId: 'proc-in' } });
  assert.equal(rt2.frames.length, 0, '入站帧不该建立 processId 关联');
  assert.equal(unrouted2.length, 1);
  assert.deepEqual(unrouted, []);
  host.dispose();
  host2.dispose();
});

// process/exited 只清**自己那条**关联。清成别人的，等于一个进程退出就把另一个 runtime
// 还在用的进程关联抹掉——它后续的 process/output 全部无人认领。
test('process/exited 只清掉这一帧归属方自己的进程关联', () => {
  const { host, registry } = hostFixture();
  const runtimeA = runtime('inst-a');
  const runtimeB = runtime('inst-b');
  registry.register(runtimeA, { instanceId: 'inst-a' });
  registry.register(runtimeB, { instanceId: 'inst-b' });
  host.attach(runtimeA);
  host.attach(runtimeB);

  // A 拥有 proc-a；B 拥有 login-b。
  host.handleObservedFrame({
    direction: 'outbound',
    frame: { id: 1, method: 'process/start', params: { processId: 'proc-a' } },
    context: { runtime: runtimeA },
  });
  host.handleObservedFrame({
    direction: 'inbound',
    method: 'account/login',
    frame: { id: 2, result: { loginId: 'login-b' } },
    context: { runtime: runtimeB },
  });

  // 这一帧靠 loginId 归到 B，却带着 A 的 processId。清关联时必须认「这条归我吗」。
  host.handleMessage({ method: 'process/exited', params: { loginId: 'login-b', processId: 'proc-a' } });
  assert.equal(runtimeB.frames.length, 1, '前置：这一帧归 B');

  host.handleMessage({ method: 'process/output', params: { processId: 'proc-a' } });
  assert.equal(runtimeA.frames.length, 1, 'A 的进程关联不该被 B 收到的退出帧清掉');
  host.dispose();
});

// request 的第四个参数要原样传给 transport。丢掉它，超时之类的调用方约定全部失效——
// 而失效的表现是"永远等下去"，不是报错。
test('request 传给 transport 的 options 不能被丢掉', async () => {
  const { host, registry } = hostFixture();
  const rt = runtime('inst-a');
  registry.register(rt, { instanceId: 'inst-a' });
  host.attach(rt);

  await withLiveEventLoop(() => assert.rejects(
    () => host.request(rt, 'thread/list', {}, { timeoutMs: 10 }),
    /timed out|timeout/i,
    'timeoutMs 必须传到 transport；丢掉它这个 promise 会永远挂着',
  ));
  host.dispose();
});
