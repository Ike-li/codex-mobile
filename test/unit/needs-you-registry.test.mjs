// test/unit/needs-you-registry.test.mjs —— 跨 thread 待办登记表的生命周期与索引契约。
// 这些性质此前只被 server-integration 间接覆盖（见 FEATURE-BREAKDOWN 附录 C）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NeedsYouRegistry } from '../../needs-you-registry.js';

const targetFor = (index, instanceId = 'inst_1') => ({
  instanceId,
  threadId: 'thr_1',
  turnId: `turn_${index}`,
  itemId: `item_${index}`,
  requestId: index,
});

// ---- 终态记录的回收 ----

test('终态记录在 TTL 之后被回收，不随 turn 数无限累积', () => {
  // close() 只把 state 改成 expired/revoked，记录本身从不移除；而 server.js 的
  // trackNeedsYou 在每个 result / error / 终态 status 上都调一次 close，
  // 于是「挂着跑几天」的网关会单调累积记录并逐步拖慢每一次扫描。
  let clock = 1_000_000;
  const registry = new NeedsYouRegistry({ ttlMs: 60_000, now: () => clock });

  for (let round = 0; round < 200; round += 1) {
    registry.open({ kind: 'approval', target: targetFor(round), payload: {}, createdAt: clock });
    registry.close({ instanceId: 'inst_1' }, { state: 'expired' });
    clock += 1_000;
  }

  const { size } = registry.stats();
  assert.ok(size <= 61, `记录数应稳定在 TTL 窗口内（≈60），实际 ${size}`);
});

test('pending 记录不会被 TTL 回收', () => {
  let clock = 1_000_000;
  const registry = new NeedsYouRegistry({ ttlMs: 60_000, now: () => clock });
  registry.open({ kind: 'approval', target: targetFor(1), payload: {}, createdAt: clock });

  clock += 600_000;
  registry.open({ kind: 'approval', target: targetFor(2), payload: {}, createdAt: clock });

  assert.equal(registry.snapshot().needs.length, 2, '未决的待办不能因为放得久就消失');
});

// ---- 扫描开销 ----

test('close 的开销不随其他 instance 的历史记录数增长', () => {
  const measure = historySize => {
    const registry = new NeedsYouRegistry();
    for (let index = 0; index < historySize; index += 1) {
      registry.open({
        kind: 'approval',
        target: targetFor(index, `inst_other_${index}`),
        payload: {},
      });
    }
    const started = performance.now();
    for (let round = 0; round < 200; round += 1) {
      registry.close({ instanceId: 'inst_absent' }, { state: 'expired' });
    }
    return performance.now() - started;
  };

  measure(500);
  const small = Math.max(measure(500), 0.05);
  const large = measure(4000);
  assert.ok(large / small < 4, `8 倍历史下 close 不应线性放大，实际 ${(large / small).toFixed(1)}×`);
});

test('close 只关闭目标 instance 的待办', () => {
  const registry = new NeedsYouRegistry();
  registry.open({ kind: 'approval', target: targetFor(1, 'inst_a'), payload: {} });
  registry.open({ kind: 'approval', target: targetFor(2, 'inst_b'), payload: {} });

  const closed = registry.close({ instanceId: 'inst_a' }, { state: 'expired' });
  assert.equal(closed.needs.length, 1);
  assert.equal(closed.needs[0].target.instanceId, 'inst_a');
  assert.deepEqual(registry.snapshot().needs.map(need => need.target.instanceId), ['inst_b']);
});

// ---- 重开语义在 TTL 前后的分界 ----

test('TTL 内重开同一 need 仍是 duplicate，异指纹仍是 conflict', () => {
  let clock = 1_000;
  const registry = new NeedsYouRegistry({ ttlMs: 60_000, now: () => clock });
  const target = targetFor(1);
  registry.open({ kind: 'approval', target, payload: { command: 'ls' }, createdAt: clock });
  registry.close({ instanceId: 'inst_1' }, { state: 'expired' });

  clock += 30_000;
  assert.equal(
    registry.open({ kind: 'approval', target, payload: { command: 'ls' }, createdAt: clock }).kind,
    'duplicate',
  );
  assert.equal(
    registry.open({ kind: 'approval', target, payload: { command: 'rm -rf /' }, createdAt: clock }).kind,
    'conflict',
  );
});

test('TTL 过后同一 need 可以重新开单', () => {
  let clock = 1_000;
  const registry = new NeedsYouRegistry({ ttlMs: 60_000, now: () => clock });
  const target = targetFor(1);
  registry.open({ kind: 'approval', target, payload: {}, createdAt: clock });
  registry.close({ instanceId: 'inst_1' }, { state: 'expired' });

  clock += 120_000;
  assert.equal(
    registry.open({ kind: 'approval', target, payload: {}, createdAt: clock }).kind,
    'opened',
  );
});

// ---- 既有行为的护栏 ----

test('snapshot 只含 pending 与 unknown，按 createdAt 排序', () => {
  const registry = new NeedsYouRegistry();
  registry.open({ kind: 'approval', target: targetFor(2), payload: {}, createdAt: 2_000 });
  registry.open({ kind: 'question', target: targetFor(1), payload: {}, createdAt: 1_000 });
  const { needs, revision } = registry.snapshot();
  assert.deepEqual(needs.map(need => need.target.turnId), ['turn_1', 'turn_2']);
  assert.equal(revision, 2);
});

test('resolve 缺任一标识即 stale', async () => {
  const registry = new NeedsYouRegistry();
  const opened = registry.open({ kind: 'approval', target: targetFor(1), payload: {} });
  const outcome = await registry.resolve(
    { needId: opened.need.needId, instanceId: 'inst_1' },
    { decision: 'accept' },
    async () => true,
  );
  assert.equal(outcome.kind, 'stale');
});

// ---- 变异补漏：批 4（APPROVAL） ----

const fullTarget = (overrides = {}) => ({
  instanceId: 'inst_1', threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_1', requestId: 7, ...overrides,
});

// `changed` 是调用方判断「要不要向所有手机广播一次」的唯一依据。九个变异全部落在它上面：
// 该 true 的判成 false，手机上的「需要你」角标就永远不更新；反过来则是每个空操作都广播一次。
// 所以每一条出路的 { kind, changed } 都要钉死，而不只是钉 kind。
test('每条出路的 kind 与 changed 都要对得上，广播与否全靠它', async () => {
  const registry = new NeedsYouRegistry({ now: () => 1000 });
  const target = fullTarget();

  const opened = registry.open({ kind: 'approval', target, payload: { a: 1 } });
  assert.equal(opened.kind, 'opened');
  assert.equal(opened.changed, true, '新开一条必须广播');

  const dup = registry.open({ kind: 'approval', target, payload: { a: 1 } });
  assert.deepEqual([dup.kind, dup.changed], ['duplicate', false], '完全相同的重开不是变化');

  const conflict = registry.open({ kind: 'approval', target, payload: { a: 2 } });
  assert.deepEqual([conflict.kind, conflict.changed], ['conflict', false], '内容不同也不改状态');

  const stale = await registry.resolve({ instanceId: 'inst_1', threadId: 'thr_1', turnId: 'nope', itemId: 'item_1', requestId: 7 },
    { ok: true }, async () => true);
  assert.deepEqual([stale.kind, stale.changed], ['stale', false], '找不到对应记录时什么都没变');

  const resolved = await registry.resolve(target, { ok: true }, async () => true);
  assert.deepEqual([resolved.kind, resolved.changed], ['resolved', true], '真的关单了就要广播');

  const resolvedDup = await registry.resolve(target, { ok: true }, async () => true);
  assert.deepEqual([resolvedDup.kind, resolvedDup.changed], ['duplicate', false]);

  const resolvedConflict = await registry.resolve(target, { ok: false }, async () => true);
  assert.deepEqual([resolvedConflict.kind, resolvedConflict.changed], ['conflict', false]);
});

test('responder 拒绝或抛异常时的两条出路各自可辨，且都算变化', async () => {
  {
    const registry = new NeedsYouRegistry({ now: () => 1000 });
    const target = fullTarget();
    registry.open({ kind: 'approval', target });
    const rejected = await registry.resolve(target, { ok: true }, async () => false);
    assert.deepEqual([rejected.kind, rejected.changed], ['stale', true],
      '上游不接受这次关单：状态确实变了（撤销），必须广播');
    assert.equal(rejected.need.state, 'revoked');
  }
  {
    const registry = new NeedsYouRegistry({ now: () => 1000 });
    const target = fullTarget();
    registry.open({ kind: 'approval', target });
    const thrown = await registry.resolve(target, { ok: true }, async () => { throw new Error('boom'); });
    assert.deepEqual([thrown.kind, thrown.changed], ['unknown', true],
      '关单结果未知也是一种变化——记录停在 unknown，仍然要让手机看到');
    assert.equal(thrown.need.state, 'unknown');
  }
  {
    // 关单进行中再来一次：不是新变化，也不能重复调 responder。
    const registry = new NeedsYouRegistry({ now: () => 1000 });
    const target = fullTarget();
    registry.open({ kind: 'approval', target });
    let calls = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = registry.resolve(target, { ok: true }, async () => { calls += 1; await gate; return true; });
    const second = await registry.resolve(target, { ok: true }, async () => { calls += 1; return true; });
    assert.deepEqual([second.kind, second.changed], ['in_progress', false]);
    release();
    await first;
    assert.equal(calls, 1, '关单进行中不能重复回包给上游');
  }
  {
    // 已经被关掉的记录再关：陈旧，不是变化。
    const registry = new NeedsYouRegistry({ now: () => 1000 });
    const target = fullTarget();
    registry.open({ kind: 'approval', target });
    registry.close({ instanceId: 'inst_1' });
    const afterClose = await registry.resolve(target, { ok: true }, async () => true);
    assert.deepEqual([afterClose.kind, afterClose.changed], ['stale', false]);
  }
});

test('kind 只有 question 与 approval 两种，其余一律归到 approval', () => {
  const registry = new NeedsYouRegistry({ now: () => 1000 });
  assert.equal(registry.open({ kind: 'question', target: fullTarget() }).need.kind, 'question');
  assert.equal(registry.open({ kind: 'approval', target: fullTarget({ turnId: 't2' }) }).need.kind, 'approval');
  assert.equal(registry.open({ kind: 'weird', target: fullTarget({ turnId: 't3' }) }).need.kind, 'approval');
  assert.equal(registry.open({ target: fullTarget({ turnId: 't4' }) }).need.kind, 'approval', '没给 kind 也归到 approval');
});

// 快照的顺序就是手机上「需要你」列表的顺序。按 createdAt 排，同刻才用 needId 兜底。
// 排错了的表现是：新来的待办插到旧的前面，用户以为旧的已经处理过了。
test('快照按创建时间排序，同刻才用 needId 兜底', () => {
  const registry = new NeedsYouRegistry({ now: () => 1000 });
  registry.open({ kind: 'approval', target: fullTarget({ turnId: 'late' }), createdAt: 300 });
  registry.open({ kind: 'approval', target: fullTarget({ turnId: 'early' }), createdAt: 100 });
  registry.open({ kind: 'approval', target: fullTarget({ turnId: 'middle' }), createdAt: 200 });

  assert.deepEqual(registry.snapshot().needs.map(need => need.target.turnId),
    ['early', 'middle', 'late'], '先来的排前面');
});

test('close 的 state 决定终态是 expired 还是 revoked', () => {
  const registry = new NeedsYouRegistry({ now: () => 1000 });
  registry.open({ kind: 'approval', target: fullTarget() });
  assert.equal(registry.close({ instanceId: 'inst_1' }, { state: 'expired' }).needs[0].state, 'expired');

  registry.open({ kind: 'approval', target: fullTarget({ turnId: 't2' }) });
  assert.equal(registry.close({ instanceId: 'inst_1' }).needs[0].state, 'revoked', '默认是 revoked');

  registry.open({ kind: 'approval', target: fullTarget({ turnId: 't3' }) });
  assert.equal(registry.close({ instanceId: 'inst_1' }, { state: 'whatever' }).needs[0].state, 'revoked',
    '认不出的 state 归到 revoked');

  assert.equal(registry.close({ instanceId: 'inst_none' }).changed, false, '什么都没关就不是变化');
});

// 目标字段是必填的，而且「空串」不算填了。放行空串的后果是所有空目标的记录
// 算出同一个 needId，互相覆盖。
test('目标标识符必填，空串与非字符串一律当场拒绝', () => {
  const registry = new NeedsYouRegistry({ now: () => 1000 });
  for (const key of ['instanceId', 'threadId', 'turnId', 'itemId']) {
    for (const bad of ['', 123, null, undefined]) {
      assert.throws(
        () => registry.open({ kind: 'approval', target: fullTarget({ [key]: bad }) }),
        new RegExp(`${key} is required`),
        `${key}=${String(bad)} 必须拒绝`,
      );
    }
  }

  // requestId 例外：它可以是字符串或有限数字（上游两种都发过）。
  assert.ok(registry.open({ kind: 'approval', target: fullTarget({ requestId: 'req-1' }) }).need);
  assert.ok(registry.open({ kind: 'approval', target: fullTarget({ requestId: 0, turnId: 't2' }) }).need);
  for (const bad of ['', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    assert.throws(
      () => registry.open({ kind: 'approval', target: fullTarget({ requestId: bad, turnId: 't3' }) }),
      /requestId is required/,
      `requestId=${String(bad)} 必须拒绝`,
    );
  }
});

// resolve 用的是「完整匹配」：五个目标字段一个都不能少。少了还放行的话，
// 一个只带 instanceId 的应答会关掉那个实例下任意一条待办——关错单。
test('resolve 要求完整目标，缺一个字段就算陈旧', async () => {
  const registry = new NeedsYouRegistry({ now: () => 1000 });
  const target = fullTarget();
  registry.open({ kind: 'approval', target });

  for (const missing of ['instanceId', 'threadId', 'turnId', 'itemId', 'requestId']) {
    const partial = { ...target };
    delete partial[missing];
    const result = await registry.resolve(partial, { ok: true }, async () => true);
    assert.equal(result.kind, 'stale', `缺 ${missing} 时不能当成匹配`);
  }

  // 显式给 null / 空串等同于没给，同样不算完整。
  for (const empty of [null, '']) {
    const result = await registry.resolve({ ...target, itemId: empty }, { ok: true }, async () => true);
    assert.equal(result.kind, 'stale', `itemId=${String(empty)} 等同于没给`);
  }

  assert.equal((await registry.resolve(target, { ok: true }, async () => true)).kind, 'resolved',
    '五个都给齐了才关得掉');
});

// close / find 用的是「部分匹配」：给了哪几个就比哪几个，但至少要给一个。
test('按部分目标关单：给了哪几个就比哪几个，一个都不给则不匹配', () => {
  const registry = new NeedsYouRegistry({ now: () => 1000 });
  registry.open({ kind: 'approval', target: fullTarget({ turnId: 'turn_a' }) });
  registry.open({ kind: 'approval', target: fullTarget({ turnId: 'turn_b' }) });

  assert.equal(registry.close({ turnId: 'turn_a' }).needs.length, 1, '只按 turnId 关一条');
  assert.equal(registry.close({}).changed, false, '一个条件都不给不该关掉所有东西');
  assert.equal(registry.close({ instanceId: 'inst_1' }).needs.length, 1, '剩下那条仍然关得掉');
});

// 记录被回收时索引也要同步收缩，但**只在真的空了之后**才删掉整个桶。
// 判反的话，同实例下还有别的待办时桶就被删了，那些记录再也按 instanceId 找不到。
test('回收一条记录不会让同实例的其它记录失去索引', () => {
  let clock = 1_000_000;
  const registry = new NeedsYouRegistry({ ttlMs: 60_000, now: () => clock });
  registry.open({ kind: 'approval', target: fullTarget({ turnId: 'gone' }), createdAt: clock });
  registry.open({ kind: 'approval', target: fullTarget({ turnId: 'alive' }), createdAt: clock });
  registry.close({ turnId: 'gone' }, { state: 'expired' });

  clock += 120_000;
  registry.prune();
  assert.equal(registry.stats().size, 1, '前置：过期那条已被回收');

  assert.equal(registry.close({ instanceId: 'inst_1' }).needs.length, 1,
    '同实例的另一条必须仍然按 instanceId 找得到');
});

// 指纹用来判 duplicate / conflict。键顺序不同的同一份内容必须算同一个指纹，
// 否则手机重发一次同样的请求（JSON 键顺序可能不同）会被判成 conflict 而拒绝。
test('指纹与键顺序无关：同一份内容换个顺序仍算重复而不是冲突', () => {
  const registry = new NeedsYouRegistry({ now: () => 1000 });
  const target = fullTarget();
  registry.open({ kind: 'approval', target, payload: { a: 1, b: { x: 1, y: 2 } } });

  const reordered = registry.open({ kind: 'approval', target, payload: { b: { y: 2, x: 1 }, a: 1 } });
  assert.equal(reordered.kind, 'duplicate', '键顺序不同不该被当成不同的内容');

  const different = registry.open({ kind: 'approval', target, payload: { a: 1, b: { x: 1, y: 3 } } });
  assert.equal(different.kind, 'conflict', '内容真的不同才算冲突');
});

test('非法的 ttlMs 回落到默认值，不把记录立刻回收也不永久保留', () => {
  let clock = 1_000_000;
  for (const bad of [-1, Number.NaN, '60000', null]) {
    const registry = new NeedsYouRegistry({ ttlMs: bad, now: () => clock });
    registry.open({ kind: 'approval', target: fullTarget(), createdAt: clock });
    registry.close({ instanceId: 'inst_1' }, { state: 'expired' });
    registry.prune();
    assert.equal(registry.stats().size, 1,
      `ttlMs=${String(bad)} 必须回落到默认的一小时，而不是让终态记录立刻消失`);
  }

  // 0 是合法值，含义是「不保留」。
  const zero = new NeedsYouRegistry({ ttlMs: 0, now: () => clock });
  zero.open({ kind: 'approval', target: fullTarget(), createdAt: clock });
  zero.close({ instanceId: 'inst_1' }, { state: 'expired' });
  zero.prune();
  assert.equal(zero.stats().size, 0, 'ttlMs=0 是显式配置的「不保留」，应当被照办');
});
