import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MessageReceiptLedger } from '../message-receipt-ledger.js';

test('receipt ledger shares one pending result and rejects a conflicting fingerprint', async () => {
  const ledger = new MessageReceiptLedger();

  const owner = ledger.claim({
    identity: 'device:a', requestId: 'req-1', fingerprint: 'same',
  });
  const duplicate = ledger.claim({
    identity: 'device:a', requestId: 'req-1', fingerprint: 'same',
  });
  const conflict = ledger.claim({
    identity: 'device:a', requestId: 'req-1', fingerprint: 'different',
  });

  assert.equal(owner.kind, 'owner');
  assert.equal(duplicate.kind, 'duplicate');
  assert.equal(conflict.kind, 'conflict');

  let replaySettled = false;
  const replay = ledger.replay(duplicate.handle).then(result => {
    replaySettled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(replaySettled, false);

  ledger.settle(owner.handle, {
    ok: true,
    receipt: { clientRequestId: 'req-1', state: 'submitted' },
  });

  assert.deepEqual(await replay, {
    ok: true,
    receipt: { clientRequestId: 'req-1', state: 'submitted' },
  });
});

test('receipt ledger keeps pending ownership past the ready timeout until the owner settles', async () => {
  const ledger = new MessageReceiptLedger({ readyTtlMs: 5 });
  const owner = ledger.claim({
    identity: 'device:a', requestId: 'req-slow', fingerprint: 'same-payload',
  });
  const waiting = ledger.claim({
    identity: 'device:a', requestId: 'req-slow', fingerprint: 'same-payload',
  });
  const replay = ledger.replay(waiting.handle);

  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(ledger.stats().size, 1);
  assert.equal(ledger.claim({
    identity: 'device:a', requestId: 'req-slow', fingerprint: 'same-payload',
  }).kind, 'duplicate');
  assert.equal(ledger.claim({
    identity: 'device:a', requestId: 'req-slow', fingerprint: 'different-payload',
  }).kind, 'conflict');

  ledger.settle(owner.handle, {
    ok: true,
    receipt: { clientRequestId: 'req-slow', state: 'submitted' },
  });
  assert.deepEqual(await replay, {
    ok: true,
    receipt: { clientRequestId: 'req-slow', state: 'submitted' },
  });
});

test('receipt ledger keeps runtime receipt transitions monotonic across settle races', async () => {
  const ledger = new MessageReceiptLedger();

  const beforeSettle = ledger.claim({
    identity: 'device:a', requestId: 'req-before', fingerprint: 'before',
  });
  assert.equal(ledger.bindRuntime(beforeSettle.handle, {
    instanceId: 'inst-a', clientRequestId: 'req-before',
  }), true);
  assert.equal(ledger.advanceRuntime({
    instanceId: 'inst-a',
    clientRequestId: 'req-before',
    receipt: { clientRequestId: 'req-before', state: 'submitted', turnId: 'turn-before' },
  }), true);
  ledger.settle(beforeSettle.handle, {
    ok: true,
    instanceId: 'inst-a',
    threadId: 'thr-a',
    receipt: { clientRequestId: 'req-before', state: 'queued' },
  });
  assert.equal((await ledger.replay(beforeSettle.handle)).receipt.state, 'submitted');

  const afterSettle = ledger.claim({
    identity: 'device:a', requestId: 'req-after', fingerprint: 'after',
  });
  ledger.bindRuntime(afterSettle.handle, {
    instanceId: 'inst-a', clientRequestId: 'req-after',
  });
  ledger.settle(afterSettle.handle, {
    ok: true,
    instanceId: 'inst-a',
    threadId: 'thr-a',
    receipt: { clientRequestId: 'req-after', state: 'queued' },
  });
  assert.equal(ledger.advanceRuntime({
    instanceId: 'inst-a',
    clientRequestId: 'req-after',
    receipt: { clientRequestId: 'req-after', state: 'submitted', turnId: 'turn-after' },
  }), true);
  assert.equal(ledger.advanceRuntime({
    instanceId: 'inst-a',
    clientRequestId: 'req-after',
    receipt: { clientRequestId: 'req-after', state: 'queued' },
  }), false);

  assert.deepEqual((await ledger.replay(afterSettle.handle)).receipt, {
    clientRequestId: 'req-after',
    state: 'submitted',
    turnId: 'turn-after',
  });
});

test('receipt ledger expires only terminal entries and fails closed at its hard cap', () => {
  let now = 0;
  const ledger = new MessageReceiptLedger({
    maxEntries: 2,
    ttlMs: 100,
    now: () => now,
  });

  const waiting = ledger.claim({
    identity: 'device:a', requestId: 'req-waiting', fingerprint: 'waiting',
  });
  ledger.settle(waiting.handle, {
    ok: true,
    receipt: { clientRequestId: 'req-waiting', state: 'queued' },
  });
  const terminal = ledger.claim({
    identity: 'device:a', requestId: 'req-terminal', fingerprint: 'terminal',
  });
  ledger.settle(terminal.handle, {
    ok: true,
    receipt: { clientRequestId: 'req-terminal', state: 'submitted' },
  });
  assert.equal(ledger.stats().size, 2);

  now = 101;
  const replacement = ledger.claim({
    identity: 'device:a', requestId: 'req-replacement', fingerprint: 'replacement',
  });
  assert.equal(replacement.kind, 'owner');
  assert.equal(ledger.stats().size, 2);
  ledger.settle(replacement.handle, {
    ok: true,
    receipt: { clientRequestId: 'req-replacement', state: 'submitted' },
  });

  const full = ledger.claim({
    identity: 'device:a', requestId: 'req-full', fingerprint: 'full',
  });
  assert.equal(full.kind, 'full');
  assert.equal(ledger.stats().size, 2);

  now = 202;
  const afterExpiry = ledger.claim({
    identity: 'device:a', requestId: 'req-after-expiry', fingerprint: 'after-expiry',
  });
  assert.equal(afterExpiry.kind, 'owner');
  assert.equal(ledger.stats().size, 2);
});

test('receipt ledger expires a settled non-retryable failure without a receipt', () => {
  let now = 0;
  const ledger = new MessageReceiptLedger({
    maxEntries: 1,
    ttlMs: 100,
    now: () => now,
  });
  const failed = ledger.claim({
    identity: 'device:a', requestId: 'req-failed', fingerprint: 'failed',
  });
  ledger.settle(failed.handle, {
    ok: false,
    retryable: false,
    errorCode: 'invalid_message',
    error: 'message rejected',
  });

  now = 101;
  const replacement = ledger.claim({
    identity: 'device:a', requestId: 'req-after-failure', fingerprint: 'replacement',
  });

  assert.equal(replacement.kind, 'owner');
  assert.equal(ledger.stats().size, 1);
});

test('receipt ledger releases a definitely unaccepted retryable request for the same-id retry', async () => {
  const ledger = new MessageReceiptLedger();
  const first = ledger.claim({
    identity: 'device:a', requestId: 'req-retry', fingerprint: 'same-payload',
  });
  const concurrentDuplicate = ledger.claim({
    identity: 'device:a', requestId: 'req-retry', fingerprint: 'same-payload',
  });
  const replay = ledger.replay(concurrentDuplicate.handle);

  ledger.settle(first.handle, {
    ok: false,
    retryable: true,
    resultUnknown: false,
    errorCode: 'queue_full',
    error: 'runtime queue is full',
  });

  assert.equal((await replay).errorCode, 'queue_full');
  const retry = ledger.claim({
    identity: 'device:a', requestId: 'req-retry', fingerprint: 'same-payload',
  });
  assert.equal(retry.kind, 'owner');
});

test('prune 回收所有已结算条目，不只是终态的', () => {
  // 这条守的是一次真实事故：原先 prune 按「是不是终态」回收，而 dispatch_failed 形状
  // （ok:false + retryable + resultUnknown）不算终态，于是这类条目永不回收。攒够
  // maxEntries 之后 claim 一律返回 'full'，网关对所有带 clientRequestId 的消息回
  // receipt_ledger_full，而那句文案是「请稍后重试」——只有重启进程才能恢复。
  //
  // 修法是把依据换成「结算过没有」（settledAt）。此后终态与非终态的区分就没有任何
  // 可观察差异了，那套区分（phase 的 'terminal' 与 terminalAt 字段）已被删除。
  let clock = 1_000_000;
  const ledger = new MessageReceiptLedger({ ttlMs: 60_000, now: () => clock });
  const claim = ledger.claim({ identity: 'device:a', requestId: 'req-1', fingerprint: 'f1' });
  ledger.settle(claim.handle, {
    ok: false, errorCode: 'dispatch_failed', retryable: true, resultUnknown: true,
  });
  assert.equal(ledger.stats().size, 1);

  clock += 120_000;
  ledger.prune();
  assert.equal(ledger.stats().size, 0, '超过 TTL 的已结算条目应被回收');
});

test('prune 不动还在派发中的条目', () => {
  // pending 条目的 ready promise 还有人等着，删掉会让 replay 永远挂住。
  let clock = 1_000_000;
  const ledger = new MessageReceiptLedger({ ttlMs: 60_000, now: () => clock });
  ledger.claim({ identity: 'device:a', requestId: 'req-1', fingerprint: 'f1' });
  clock += 120_000;
  ledger.prune();
  assert.equal(ledger.stats().size, 1, '还在派发中的条目不能删');
});


// ---- 变异补漏：批 3（DELIVER + RECOVER） ----

// 回执有等级：queued(1) < submitted / steered / rejected(2)。既有测试覆盖了
// 「submitted 之后 queued 要被拒」，但变异显示 receiptRank / canAdvanceReceipt 的
// 6 个变异全部存活——因为那一对的**顺序**在多种错误实现下都恰好成立。
// 能区分的是另一对：两个都是等级 2、含义却相反的状态。
test('回执不在两个矛盾的终态之间改判：submitted 之后再来 rejected 要被拒', () => {
  const ledger = new MessageReceiptLedger();
  const claim = ledger.claim({ identity: 'device:a', requestId: 'req-x', fingerprint: 'f' });
  ledger.bindRuntime(claim.handle, { instanceId: 'inst', clientRequestId: 'req-x' });
  ledger.settle(claim.handle, { ok: true, receipt: { clientRequestId: 'req-x', state: 'queued', queuedAt: 7 } });

  assert.equal(ledger.advanceRuntime({
    instanceId: 'inst', clientRequestId: 'req-x',
    receipt: { clientRequestId: 'req-x', state: 'submitted', turnId: 'turn-1' },
  }), true, 'queued → submitted 是正常推进');

  // submitted 与 rejected 都是终态，含义相反。让后到的覆盖，手机上这条消息就会从
  // 「已发出」翻成「被拒绝」——而事实只有一个，翻转的那次一定是错的。
  assert.equal(ledger.advanceRuntime({
    instanceId: 'inst', clientRequestId: 'req-x',
    receipt: { clientRequestId: 'req-x', state: 'rejected', errorCode: 'nope' },
  }), false, '两个矛盾的终态之间不得改判');

  // 同一个终态补字段是允许的：那是同一件事的更多细节，不是改判。
  assert.equal(ledger.advanceRuntime({
    instanceId: 'inst', clientRequestId: 'req-x',
    receipt: { clientRequestId: 'req-x', state: 'submitted', threadId: 'thr-1' },
  }), true, '同一终态补充字段不算改判');
});

// 合并而不是替换：低等级回执上的字段要保留下来。只断言 state 的话，
// 「直接拿新的整个换掉旧的」也能让测试变绿，而那会丢掉 queuedAt 这类只在早期回执上出现的信息。
test('推进回执是合并，不是替换——早期回执独有的字段要留下来', async () => {
  const ledger = new MessageReceiptLedger();
  const claim = ledger.claim({ identity: 'device:a', requestId: 'req-m', fingerprint: 'f' });
  ledger.bindRuntime(claim.handle, { instanceId: 'inst', clientRequestId: 'req-m' });
  ledger.settle(claim.handle, { ok: true, receipt: { clientRequestId: 'req-m', state: 'queued', queuedAt: 42 } });
  ledger.advanceRuntime({
    instanceId: 'inst', clientRequestId: 'req-m',
    receipt: { clientRequestId: 'req-m', state: 'submitted', turnId: 'turn-m' },
  });

  assert.deepEqual((await ledger.replay(claim.handle)).receipt, {
    clientRequestId: 'req-m',
    state: 'submitted',
    queuedAt: 42,
    turnId: 'turn-m',
  }, 'queuedAt 来自旧回执、turnId 来自新回执，两边都要在');
});

// runtimeIndex 是 (instanceId, clientRequestId) → 条目 的唯一映射。它错了的后果是
// **回执串台**：A 的回执落到 B 头上，用户在 B 那条消息上看到 A 的结果。
test('bindRuntime 独占一个 runtime key，重绑时旧 key 必须失效', () => {
  const ledger = new MessageReceiptLedger();
  const a = ledger.claim({ identity: 'device:a', requestId: 'req-a', fingerprint: 'fa' });
  const b = ledger.claim({ identity: 'device:a', requestId: 'req-b', fingerprint: 'fb' });

  assert.equal(ledger.bindRuntime(a.handle, { instanceId: 'inst', clientRequestId: 'k' }), true);
  assert.equal(ledger.bindRuntime(b.handle, { instanceId: 'inst', clientRequestId: 'k' }), false,
    '一个 runtime key 只能属于一个条目，抢过去就意味着 a 的回执会落到 b 头上');

  // 缺任一段都不建索引：空串拼出来的 key（如 `inst\0`）会把不同请求撞进同一个格子。
  assert.equal(ledger.bindRuntime(a.handle, { instanceId: '', clientRequestId: 'k2' }), false);
  assert.equal(ledger.bindRuntime(a.handle, { instanceId: 'inst', clientRequestId: '' }), false);
  assert.equal(ledger.bindRuntime(undefined, { instanceId: 'inst', clientRequestId: 'k2' }), false);

  // 重绑到新 key 后，旧 key 必须失效，否则走旧 key 的回执还会被接受。
  assert.equal(ledger.bindRuntime(a.handle, { instanceId: 'inst', clientRequestId: 'k-new' }), true);
  ledger.settle(a.handle, { ok: true, receipt: { clientRequestId: 'k-new', state: 'queued' } });
  assert.equal(ledger.advanceRuntime({
    instanceId: 'inst', clientRequestId: 'k',
    receipt: { clientRequestId: 'k', state: 'submitted' },
  }), false, '旧 key 必须已经失效');
  assert.equal(ledger.advanceRuntime({
    instanceId: 'inst', clientRequestId: 'k-new',
    receipt: { clientRequestId: 'k-new', state: 'submitted' },
  }), true, '新 key 应当生效');
});

// 条目被回收时 runtimeIndex 里的那条也要一起删。漏删的话，索引会一直指向一个
// 已经不在账本里的条目——后到的回执照样被"接受"，而那个条目谁也读不到了。
test('回收条目时同步清掉 runtime 索引，不留下指向已删条目的键', () => {
  let clock = 1_000_000;
  const ledger = new MessageReceiptLedger({ ttlMs: 60_000, now: () => clock });
  const claim = ledger.claim({ identity: 'device:a', requestId: 'req-gc', fingerprint: 'f' });
  ledger.bindRuntime(claim.handle, { instanceId: 'inst', clientRequestId: 'k-gc' });
  ledger.settle(claim.handle, { ok: true });

  clock += 120_000;
  ledger.prune();
  assert.equal(ledger.stats().size, 0, '前置：条目应当已被回收');

  assert.equal(ledger.advanceRuntime({
    instanceId: 'inst', clientRequestId: 'k-gc',
    receipt: { clientRequestId: 'k-gc', state: 'submitted' },
  }), false, '条目已回收，它的 runtime key 不能还认账');
});

// 非法配置回落到默认值。maxEntries=0 若被当成有效值，第一次 claim 就返回 'full'：
// 网关会对所有带 clientRequestId 的消息回 receipt_ledger_full，而那句文案是「请稍后重试」
// ——一句永远不会兑现的话，只有重启进程才能恢复。
test('非法的容量与 TTL 配置回落到默认值，不把账本锁死、也不让去重失效', () => {
  for (const bad of [0, -1, 2.5, Number.NaN, '10', null, undefined]) {
    const ledger = new MessageReceiptLedger({ maxEntries: bad });
    assert.equal(
      ledger.claim({ identity: 'd', requestId: 'r', fingerprint: 'f' }).kind, 'owner',
      `maxEntries=${String(bad)} 必须回落到默认值，而不是让账本一开始就是满的`,
    );
  }

  // ttlMs 为负若被当成有效值，cutoff 会跑到未来，条目一结算就被回收——去重整个失效，
  // 同一条消息重发会被当成新消息再执行一次。这正是账本存在的理由。
  for (const bad of [-1, Number.NaN, '100', null]) {
    const ledger = new MessageReceiptLedger({ ttlMs: bad, now: () => 1000 });
    const first = ledger.claim({ identity: 'd', requestId: 'r', fingerprint: 'f' });
    ledger.settle(first.handle, { ok: true });
    assert.equal(
      ledger.claim({ identity: 'd', requestId: 'r', fingerprint: 'f' }).kind, 'duplicate',
      `ttlMs=${String(bad)} 必须回落到默认值，否则条目一结算就被清掉，去重失效`,
    );
  }

  // 0 是合法值（`>= 0`），含义是「不保留」。把它也判成非法会让显式配置被无声忽略。
  const zeroTtl = new MessageReceiptLedger({ ttlMs: 0, now: () => 1000 });
  const claim = zeroTtl.claim({ identity: 'd', requestId: 'r', fingerprint: 'f' });
  zeroTtl.settle(claim.handle, { ok: true });
  assert.equal(zeroTtl.claim({ identity: 'd', requestId: 'r', fingerprint: 'f' }).kind, 'owner',
    'ttlMs=0 是显式配置的「不保留」，应当被照办');
});

// 排队中（waiting）的条目由 abandonedTtlMs 管，与已结算条目的 ttlMs 是两把不同的尺子。
test('排队中的条目按 abandonedTtlMs 回收，非法值同样回落', () => {
  const queued = { ok: true, receipt: { clientRequestId: 'r', state: 'queued' } };

  // 负值若被当成有效值，还在排队的消息会立刻被回收——它的回执查不到了，
  // reconcile 会判定「没执行过」而重发，同一条消息发两次。
  let clock = 1_000_000;
  const bad = new MessageReceiptLedger({ ttlMs: 60_000, abandonedTtlMs: -1, now: () => clock });
  const badClaim = bad.claim({ identity: 'd', requestId: 'r', fingerprint: 'f' });
  bad.settle(badClaim.handle, queued);
  bad.prune();
  assert.equal(bad.stats().size, 1, 'abandonedTtlMs=-1 必须回落到默认值，排队中的消息不能立刻被清掉');

  // 0 同样是合法的显式配置。
  clock = 1_000_000;
  const zero = new MessageReceiptLedger({ ttlMs: 60_000, abandonedTtlMs: 0, now: () => clock });
  const zeroClaim = zero.claim({ identity: 'd', requestId: 'r', fingerprint: 'f' });
  zero.settle(zeroClaim.handle, queued);
  zero.prune();
  assert.equal(zero.stats().size, 0, 'abandonedTtlMs=0 是显式配置的「不保留」，应当被照办');
});

// settle / advanceRuntime 的返回值是调用方判断「我该不该回复客户端」的依据。
test('settle 只认第一次，advanceRuntime 只认得出已绑定的条目', async () => {
  const ledger = new MessageReceiptLedger();
  const claim = ledger.claim({ identity: 'd', requestId: 'r', fingerprint: 'f' });

  assert.equal(ledger.settle(claim.handle, { ok: true, status: 'first' }), true, '第一次结算成功');
  assert.equal(ledger.settle(claim.handle, { ok: false, error: '晚到的第二个结果' }), false,
    '同一条目不能被结算两次：后到的结果会覆盖已经回给客户端的那个');
  assert.equal(ledger.settle(undefined, { ok: true }), false, '不认识的 handle 不算结算成功');
  assert.deepEqual(await ledger.replay(claim.handle), { ok: true, status: 'first' },
    '第一次的结果必须原样保留');

  assert.equal(ledger.advanceRuntime({
    instanceId: 'x', clientRequestId: 'y', receipt: { state: 'submitted' },
  }), false, '没绑过的 runtime key 推进不了');

  ledger.bindRuntime(claim.handle, { instanceId: 'x', clientRequestId: 'y' });
  assert.equal(ledger.advanceRuntime({ instanceId: 'x', clientRequestId: 'y', receipt: null }), false,
    '没有回执就没有可推进的东西');
});

// rejected 回执要把自带的错误文案透出去。丢掉它、换成通用文案，用户看到的就是
// 「消息未被 Codex runtime 接受」而不是真正的原因，排查时少了唯一的线索。
test('被拒回执自带的错误文案要透出去，没有才用兜底文案', async () => {
  const ledger = new MessageReceiptLedger();
  const withReason = ledger.claim({ identity: 'd', requestId: 'r1', fingerprint: 'f' });
  ledger.settle(withReason.handle, {
    ok: true,
    receipt: { clientRequestId: 'r1', state: 'rejected', errorCode: 'thread_closed', error: '会话已关闭' },
  });
  const detailed = await ledger.replay(withReason.handle);
  assert.equal(detailed.ok, false, 'rejected 回执必须把整体结果翻成失败');
  assert.equal(detailed.errorCode, 'thread_closed');
  assert.equal(detailed.error, '会话已关闭');

  const bare = ledger.claim({ identity: 'd', requestId: 'r2', fingerprint: 'f' });
  ledger.settle(bare.handle, { ok: true, receipt: { clientRequestId: 'r2', state: 'rejected' } });
  const fallback = await ledger.replay(bare.handle);
  assert.equal(fallback.errorCode, 'dispatch_rejected');
  assert.match(fallback.error, /未被 Codex runtime 接受/);
});

// settle 时如果已经有更靠前的回执（advanceRuntime 先到），要把两边**合并**，
// 而不是直接采用其中一份。只断言 state 的话，「整个换成 latest」也能绿。
test('结算时若已有更靠前的回执，合并两份而不是丢掉其中一份', async () => {
  const ledger = new MessageReceiptLedger();
  const claim = ledger.claim({ identity: 'device:a', requestId: 'req-race', fingerprint: 'f' });
  ledger.bindRuntime(claim.handle, { instanceId: 'inst', clientRequestId: 'req-race' });

  // 回执先于结算到达（真实竞态：runtime 的事件比 RPC 应答快）。
  ledger.advanceRuntime({
    instanceId: 'inst', clientRequestId: 'req-race',
    receipt: { clientRequestId: 'req-race', state: 'submitted', turnId: 'turn-race' },
  });
  // 结算带来的是更早的状态，但它带着只有这一侧才有的字段。
  ledger.settle(claim.handle, {
    ok: true,
    receipt: { clientRequestId: 'req-race', state: 'queued', queuedAt: 11 },
  });

  assert.deepEqual((await ledger.replay(claim.handle)).receipt, {
    clientRequestId: 'req-race',
    state: 'submitted',
    queuedAt: 11,
    turnId: 'turn-race',
  }, 'state 取更靠前的那个，字段两边都要保留');
});

// 还在收到回执的条目是活的，不该按**最初**结算时间被回收。
// 回收早了，后续的 reconcile 查不到它，会判定「没执行过」而重发同一条消息。
test('推进回执会刷新结算时间，持续活跃的条目不被按旧时间回收', () => {
  let clock = 0;
  const ledger = new MessageReceiptLedger({ ttlMs: 100, now: () => clock });
  const claim = ledger.claim({ identity: 'device:a', requestId: 'req-live', fingerprint: 'f' });
  ledger.bindRuntime(claim.handle, { instanceId: 'inst', clientRequestId: 'req-live' });
  ledger.settle(claim.handle, { ok: true, receipt: { clientRequestId: 'req-live', state: 'queued' } });

  clock = 90;
  ledger.advanceRuntime({
    instanceId: 'inst', clientRequestId: 'req-live',
    receipt: { clientRequestId: 'req-live', state: 'submitted' },
  });

  clock = 150;
  ledger.prune();
  assert.equal(ledger.stats().size, 1,
    't=90 才收到新回执，到 t=150 还没过 100ms 的 TTL；按 t=0 算就会被提前回收');

  clock = 200;
  ledger.prune();
  assert.equal(ledger.stats().size, 0, '真的过期之后仍然要回收');
});
