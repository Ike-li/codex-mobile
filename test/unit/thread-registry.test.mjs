import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadRegistry } from '../../src/sessions/thread-registry.js';

function assertStale(action) {
  assert.throws(action, error => {
    assert.equal(error?.code, 'stale_target');
    return true;
  });
}

test('registers a provisional instance and atomically binds its thread', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  assert.equal(registry.register(runtime, { instanceId: 'inst-a' }), runtime);
  assert.equal(registry.resolve({ instanceId: 'inst-a' }), runtime);
  assertStale(() => registry.resolve({ threadId: 'thr-a' }));

  assert.equal(registry.bind(runtime, { threadId: 'thr-a' }), runtime);
  assert.equal(registry.resolve({ instanceId: 'inst-a', threadId: 'thr-a' }), runtime);
  assert.deepEqual(registry.snapshot(), [{
    runtime,
    instanceId: 'inst-a',
    threadId: 'thr-a',
    turnId: null,
    requestIds: [],
  }]);
});

test('register can bind an initial thread and repeated identical bindings are idempotent', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtime, { threadId: 'thr-a', turnId: 'turn-a', requestId: 'req-a' });
  registry.bind(runtime, { threadId: 'thr-a', turnId: 'turn-a', requestId: 'req-a' });

  assert.equal(registry.resolve({
    instanceId: 'inst-a',
    threadId: 'thr-a',
    turnId: 'turn-a',
    requestId: 'req-a',
  }), runtime);
});

test('all provided identifiers must resolve to the same runtime', () => {
  const registry = new ThreadRegistry();
  const runtimeA = { name: 'runtime-a' };
  const runtimeB = { name: 'runtime-b' };

  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtimeA, { turnId: 'turn-a', requestId: 'req-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  registry.bind(runtimeB, { turnId: 'turn-b', requestId: 'req-b' });

  assertStale(() => registry.resolve({ instanceId: 'inst-a', threadId: 'thr-b' }));
  assertStale(() => registry.resolve({ threadId: 'thr-a', turnId: 'turn-b' }));
  assertStale(() => registry.resolve({ turnId: 'turn-a', requestId: 'req-b' }));
  assertStale(() => registry.resolve({ instanceId: 'missing' }));
  assertStale(() => registry.resolve({}));
});

test('thread ids have one owner while local turn and request ids require context', () => {
  const registry = new ThreadRegistry();
  const runtimeA = { name: 'runtime-a' };
  const runtimeB = { name: 'runtime-b' };

  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-owned' });
  registry.bind(runtimeA, { turnId: 'turn-owned', requestId: 'req-owned' });
  registry.register(runtimeB, { instanceId: 'inst-b' });

  assertStale(() => registry.bind(runtimeB, { threadId: 'thr-owned' }));
  registry.bind(runtimeB, { turnId: 'turn-owned' });
  registry.bind(runtimeB, { requestId: 'req-owned' });

  assert.equal(registry.resolve({ threadId: 'thr-owned' }), runtimeA);
  assert.equal(registry.resolve({ instanceId: 'inst-a', turnId: 'turn-owned' }), runtimeA);
  assert.equal(registry.resolve({ instanceId: 'inst-b', turnId: 'turn-owned' }), runtimeB);
  assertStale(() => registry.resolve({ turnId: 'turn-owned' }));
  assert.equal(registry.resolve({ instanceId: 'inst-a', requestId: 'req-owned' }), runtimeA);
  assert.equal(registry.resolve({ instanceId: 'inst-b', requestId: 'req-owned' }), runtimeB);
  assertStale(() => registry.resolve({ requestId: 'req-owned' }));
});

test('bind is atomic when any requested identifier conflicts', () => {
  const registry = new ThreadRegistry();
  const runtimeA = { name: 'runtime-a' };
  const runtimeB = { name: 'runtime-b' };

  registry.register(runtimeA, { instanceId: 'inst-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });

  assertStale(() => registry.bind(runtimeA, {
    threadId: 'thr-b',
    turnId: 'turn-a',
    requestId: 'req-a',
  }));

  assertStale(() => registry.resolve({ turnId: 'turn-a' }));
  assertStale(() => registry.resolve({ requestId: 'req-a' }));
  assert.equal(registry.resolve({ instanceId: 'inst-a' }), runtimeA);
  assert.deepEqual(registry.snapshot().find(entry => entry.runtime === runtimeA), {
    runtime: runtimeA,
    instanceId: 'inst-a',
    threadId: null,
    turnId: null,
    requestIds: [],
  });
});

test('a runtime can own multiple request identifiers including numeric RPC ids', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtime, { requestId: 'client-request-a' });
  registry.bind(runtime, { requestId: 0 });
  registry.bind(runtime, { requestId: 42 });

  assert.equal(registry.resolve({ requestId: 'client-request-a' }), runtime);
  assert.equal(registry.resolve({ requestId: 0 }), runtime);
  assert.equal(registry.resolve({ requestId: 42, threadId: 'thr-a' }), runtime);
  assert.deepEqual(registry.snapshot()[0].requestIds, ['client-request-a', 0, 42]);
});

test('releaseRequest removes one completed request without releasing its runtime', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtime, { requestId: 'request-a' });
  registry.bind(runtime, { requestId: 'request-b' });

  assert.equal(registry.releaseRequest(runtime, 'request-a'), true);
  assert.equal(registry.releaseRequest(runtime, 'request-a'), false);
  assertStale(() => registry.resolve({ instanceId: 'inst-a', requestId: 'request-a' }));
  assert.equal(registry.resolve({ instanceId: 'inst-a', requestId: 'request-b' }), runtime);
  assert.equal(registry.resolve({ instanceId: 'inst-a', threadId: 'thr-a' }), runtime);
});

test('transport-local request ids can repeat but require an owner identifier to resolve', () => {
  const registry = new ThreadRegistry();
  const runtimeA = { name: 'runtime-a' };
  const runtimeB = { name: 'runtime-b' };

  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  registry.bind(runtimeA, { requestId: 1 });
  registry.bind(runtimeB, { requestId: 1 });

  assert.equal(registry.resolve({ instanceId: 'inst-a', requestId: 1 }), runtimeA);
  assert.equal(registry.resolve({ threadId: 'thr-b', requestId: 1 }), runtimeB);
  assertStale(() => registry.resolve({ requestId: 1 }));
});

test('binding a new active turn replaces the previous turn index', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtime, { turnId: 'turn-1' });
  registry.bind(runtime, { turnId: 'turn-2' });

  assertStale(() => registry.resolve({ turnId: 'turn-1' }));
  assert.equal(registry.resolve({ turnId: 'turn-2' }), runtime);
  assert.equal(registry.snapshot()[0].turnId, 'turn-2');
});

test('clearTurn removes only the expected active turn ownership', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtime, { turnId: 'turn-current' });

  assert.equal(registry.clearTurn(runtime, 'turn-stale'), false);
  assert.equal(registry.resolve({ instanceId: 'inst-a', turnId: 'turn-current' }), runtime);
  assert.equal(registry.clearTurn(runtime, 'turn-current'), true);
  assertStale(() => registry.resolve({ turnId: 'turn-current' }));
  assert.equal(registry.resolve({ instanceId: 'inst-a', threadId: 'thr-a' }), runtime);
});

test('transport-local turn ids can repeat but require a thread or instance to resolve', () => {
  const registry = new ThreadRegistry();
  const runtimeA = { name: 'runtime-a' };
  const runtimeB = { name: 'runtime-b' };

  registry.register(runtimeA, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.register(runtimeB, { instanceId: 'inst-b', threadId: 'thr-b' });
  registry.bind(runtimeA, { turnId: 'turn-local-1' });
  registry.bind(runtimeB, { turnId: 'turn-local-1' });

  assert.equal(registry.resolve({ threadId: 'thr-a', turnId: 'turn-local-1' }), runtimeA);
  assert.equal(registry.resolve({ instanceId: 'inst-b', turnId: 'turn-local-1' }), runtimeB);
  assertStale(() => registry.resolve({ turnId: 'turn-local-1' }));
});

test('a runtime cannot be rebound to a different instance or thread', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });

  assertStale(() => registry.register(runtime, { instanceId: 'inst-b' }));
  assertStale(() => registry.bind(runtime, { threadId: 'thr-b' }));
  assert.equal(registry.resolve({ instanceId: 'inst-a', threadId: 'thr-a' }), runtime);
  assertStale(() => registry.resolve({ instanceId: 'inst-b' }));
  assertStale(() => registry.resolve({ threadId: 'thr-b' }));
});

test('release removes every index owned by a runtime', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.bind(runtime, { turnId: 'turn-a', requestId: 'req-a' });
  registry.bind(runtime, { requestId: 'req-b' });

  assert.equal(registry.release(runtime), true);
  assert.equal(registry.release(runtime), false);
  assert.deepEqual(registry.snapshot(), []);
  for (const target of [
    { instanceId: 'inst-a' },
    { threadId: 'thr-a' },
    { turnId: 'turn-a' },
    { requestId: 'req-a' },
    { requestId: 'req-b' },
  ]) {
    assertStale(() => registry.resolve(target));
  }
});

// —— 下面三条来自一次变异运行：114 个变异存活 14 个，这三处是其中爆炸半径最大的。
// 存活意味着改坏那行代码测试也不会红，而它们守的是 ROUTE-01/02 的核心：
// 一个 thread 同时只有一个 owner，标识不全或冲突时拒绝路由而不是猜。

// 变异 `assertAvailable` 那行的条件后测试仍绿 —— 说明「注册时 threadId 已被别人占用」
// 这条路径没有断言。bind 的冲突有测试，register 的没有，而 register 是先到的那一步。
test('register rejects a threadId that another runtime already owns', () => {
  const registry = new ThreadRegistry();
  const first = { name: 'first' };
  const second = { name: 'second' };

  registry.register(first, { instanceId: 'inst-a', threadId: 'thr-1' });
  assertStale(() => registry.register(second, { instanceId: 'inst-b', threadId: 'thr-1' }));

  // 抢注失败不得留下半个记录：thread 仍归第一个，第二个的 instanceId 也不该被占住。
  assert.equal(registry.resolve({ threadId: 'thr-1' }), first);
  assertStale(() => registry.resolve({ instanceId: 'inst-b' }));
});

// requireRuntime 是所有入口的第一道闸，把它的 `||` 改成 `&&` 后它永远不抛
// （一个值不可能同时 === null 和 === undefined），而测试全绿。
test('null and undefined runtimes are rejected at the entry points', () => {
  const registry = new ThreadRegistry();

  for (const bad of [null, undefined]) {
    assertStale(() => registry.register(bad, { instanceId: 'inst-a' }));
    assertStale(() => registry.bind(bad, { threadId: 'thr-a' }));
  }
});

// deleteOwned 里 `value.size === 0` 改成 `!== 0` 后测试仍绿 —— 说明没有断言覆盖
// 「同一个 turn id 被两个 runtime 持有，释放其中一个」。改坏后索引条目会在还有
// owner 时被整条删掉，另一个 runtime 就再也解析不到自己的 turn。
test('releasing one owner of a repeated turn id leaves the other owner resolvable', () => {
  const registry = new ThreadRegistry();
  const a = { name: 'a' };
  const b = { name: 'b' };

  registry.register(a, { instanceId: 'inst-a', threadId: 'thr-a' });
  registry.register(b, { instanceId: 'inst-b', threadId: 'thr-b' });
  // transport-local 的 turn id 可以重复，靠 thread/instance 消歧。
  registry.bind(a, { turnId: 'turn-1' });
  registry.bind(b, { turnId: 'turn-1' });

  assert.equal(registry.resolve({ threadId: 'thr-a', turnId: 'turn-1' }), a);
  assert.equal(registry.resolve({ threadId: 'thr-b', turnId: 'turn-1' }), b);

  registry.clearTurn(a, 'turn-1');

  assert.equal(registry.resolve({ threadId: 'thr-b', turnId: 'turn-1' }), b,
    '释放 a 的 turn 不得连带删掉 b 对同一个 id 的所有权');
});

// 重复注册同一个 runtime 时带上 threadId：现有的幂等测试只覆盖了不带 threadId 的那条路，
// 于是「重复注册时顺带完成绑定」和「返回值仍是 runtime」两处都没有断言咬住。
test('re-registering the same runtime binds a newly supplied threadId', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  registry.register(runtime, { instanceId: 'inst-a' });
  assert.equal(registry.register(runtime, { instanceId: 'inst-a', threadId: 'thr-a' }), runtime);

  assert.equal(registry.resolve({ threadId: 'thr-a' }), runtime);
});

// 标识不合法时要拒绝而不是猜（ROUTE-02）。这两个校验函数的 `||` / `&&` 被改坏后
// 测试全绿 —— 非字符串 id 和 NaN 请求 id 都没有被任何断言盯着。
test('malformed identifiers are rejected instead of being coerced', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'runtime-a' };

  for (const bad of [42, {}, [], true]) {
    assertStale(() => registry.register(runtime, { instanceId: bad }));
  }

  registry.register(runtime, { instanceId: 'inst-a' });
  for (const bad of ['', '   ']) {
    assertStale(() => registry.bind(runtime, { threadId: bad }));
  }
  // requestId 允许数字，但必须是有限数 —— NaN / Infinity 当成合法 id 会让
  // 后续的所有权查找永远命不中，而且没有任何报错。
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assertStale(() => registry.bind(runtime, { requestId: bad }));
  }
});

// provisional runtime（还没有 thread）绑定一个 turn 时，不得顺手把 threadId 写成 undefined。
// 把那行的 `&&` 改成 `||` 就会这样，而且会往 thread 索引里塞一个 undefined 键。
test('binding a turn on a thread-less runtime does not corrupt the thread index', () => {
  const registry = new ThreadRegistry();
  const runtime = { name: 'provisional' };

  registry.register(runtime, { instanceId: 'inst-a' });
  registry.bind(runtime, { turnId: 'turn-1' });

  assert.deepEqual(registry.snapshot(), [{
    runtime,
    instanceId: 'inst-a',
    threadId: null,
    turnId: 'turn-1',
    requestIds: [],
  }], 'threadId 必须仍是 null，不能被写成 undefined');
  // 不用 resolve 来验索引干净：{ threadId: undefined } 会被 optionalStringId 当成
  // 「没提供这个标识」，等价于 resolve({ turnId })，验不到索引里有没有 undefined 键。
  // snapshot 的 deepEqual 已经足够——被写成 undefined 时 null !== undefined 会红。
});

// 对一个从未注册过的 runtime 做释放：必须安静地返回 false，不能抛。
// server.js 在事件到达时会直接调用这两个方法，而那时 runtime 可能已经被 release 掉了。
test('releasing turns or requests for an unknown runtime is a no-op, not a throw', () => {
  const registry = new ThreadRegistry();
  const ghost = { name: 'never-registered' };

  assert.equal(registry.clearTurn(ghost), false);
  assert.equal(registry.releaseRequest(ghost, 'req-1'), false);
  assert.equal(registry.release(ghost), false);
});
