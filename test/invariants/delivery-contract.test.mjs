// test/invariants/delivery-contract.test.mjs —— 投递与「需要你」的外部可观察契约。
// 守护：DELIVER-01
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageReceiptLedger } from '../../message-receipt-ledger.js';
import { NeedsYouRegistry } from '../../needs-you-registry.js';

// 「不丢不重」与「需要人时叫得到人」的行为契约。
//
// 这一组测试刻意只断言**外部可观察行为**：同一请求发两次会怎样、断线重连后能查到什么、
// 处理过的审批再处理一次会怎样。不碰 phase / revision / handles 这些内部结构，因为它们
// 是实现细节——现有测试大量断言内部形态，重构时会一起被改掉，那就失去了安全网的意义。
//
// 目的：为后续拆解这两个模块提供一张与实现无关的网。任何改动如果让这里变红，就是真的
// 改变了用户可见的行为，而不只是换了个写法。

function makeLedger() {
  return new MessageReceiptLedger({ now: () => 1000 });
}

const IDENTITY = 'device-a';

test('契约：同一请求重复到达只执行一次，结果对两次调用一致', async () => {
  const ledger = makeLedger();
  const first = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  assert.equal(first.kind, 'owner', '第一次是所有者，应当真正执行');

  const second = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  assert.equal(second.kind, 'duplicate', '第二次不得再执行一遍');

  ledger.settle(first.handle, { ok: true, status: 'done' });
  assert.deepEqual(await ledger.replay(second.handle), { ok: true, status: 'done' },
    '重复请求必须拿到与首次相同的结果，而不是自己再跑一次');
});

test('契约：同一 id 携带不同内容会被拒绝，不能悄悄覆盖', async () => {
  const ledger = makeLedger();
  ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp-a' });
  const conflicting = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp-b' });
  assert.equal(conflicting.kind, 'conflict');
});

test('契约：不同设备的相同 requestId 互不影响', async () => {
  const ledger = makeLedger();
  const a = ledger.claim({ identity: 'device-a', requestId: 'req-1', fingerprint: 'fp' });
  const b = ledger.claim({ identity: 'device-b', requestId: 'req-1', fingerprint: 'fp' });
  assert.equal(a.kind, 'owner');
  assert.equal(b.kind, 'owner', '另一台设备的同名请求是独立的一次发送');
});

test('契约：重连后按请求 id 能查到已完成的结果，无需重发', async () => {
  const ledger = makeLedger();
  const claim = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  ledger.settle(claim.handle, { ok: true, status: 'done' });

  // 断线重连走的是这条路：客户端只有 requestId，没有 handle。
  assert.deepEqual(await ledger.replayByRequest({ identity: IDENTITY, requestId: 'req-1' }),
    { ok: true, status: 'done' });
  assert.equal(await ledger.replayByRequest({ identity: IDENTITY, requestId: 'never-sent' }), null,
    '没发过的请求查不到东西，客户端据此判断需要重发');
});

test('契约：结果尚未产生时查询会等待，不会得到「不存在」', async () => {
  const ledger = makeLedger();
  const claim = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  const pending = ledger.replayByRequest({ identity: IDENTITY, requestId: 'req-1' });
  let settledFirst = false;
  pending.then(() => { settledFirst = true; });
  await Promise.resolve();
  assert.equal(settledFirst, false, '结果没出来之前不能提前返回 null——那会让客户端重发');

  ledger.settle(claim.handle, { ok: true, status: 'done' });
  assert.deepEqual(await pending, { ok: true, status: 'done' });
});

test('契约：可重试的失败不留痕，用户重试时是干净的一次新发送', async () => {
  const ledger = makeLedger();
  const claim = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  ledger.settle(claim.handle, { ok: false, retryable: true, error: 'network' });

  const retry = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  assert.equal(retry.kind, 'owner', '失败且可重试时，同一 id 应能重新发起');
});

test('契约：结果未知的失败必须留痕，不能当成没发生过', async () => {
  const ledger = makeLedger();
  const claim = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  ledger.settle(claim.handle, { ok: false, retryable: true, resultUnknown: true, error: 'timeout' });

  const retry = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  assert.equal(retry.kind, 'duplicate',
    '结果未知时不能默默重发——可能已经执行过了，重发就是执行两次');
});

test('契约：runtime 回执把「排队中」推进到「已提交」，并对查询可见', async () => {
  const ledger = makeLedger();
  const claim = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  ledger.bindRuntime(claim.handle, { instanceId: 'inst-1', clientRequestId: 'req-1' });
  ledger.settle(claim.handle, { ok: true, receipt: { state: 'queued' } });

  ledger.advanceRuntime({ instanceId: 'inst-1', clientRequestId: 'req-1', receipt: { state: 'submitted' } });
  const seen = await ledger.replayByRequest({ identity: IDENTITY, requestId: 'req-1' });
  assert.equal(seen.receipt.state, 'submitted', '回执推进要能被后续查询看到');
});

test('契约：runtime 拒收会把结果翻成失败，不能显示为成功', async () => {
  const ledger = makeLedger();
  const claim = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  ledger.bindRuntime(claim.handle, { instanceId: 'inst-1', clientRequestId: 'req-1' });
  ledger.settle(claim.handle, { ok: true, receipt: { state: 'queued' } });

  ledger.advanceRuntime({
    instanceId: 'inst-1',
    clientRequestId: 'req-1',
    receipt: { state: 'rejected', errorCode: 'queue_full' },
  });
  const seen = await ledger.replayByRequest({ identity: IDENTITY, requestId: 'req-1' });
  assert.equal(seen.ok, false);
  assert.equal(seen.errorCode, 'queue_full');
});

test('契约：回执不能倒退，已提交不会被迟到的「排队中」覆盖', async () => {
  const ledger = makeLedger();
  const claim = ledger.claim({ identity: IDENTITY, requestId: 'req-1', fingerprint: 'fp' });
  ledger.bindRuntime(claim.handle, { instanceId: 'inst-1', clientRequestId: 'req-1' });
  ledger.settle(claim.handle, { ok: true, receipt: { state: 'submitted' } });

  ledger.advanceRuntime({ instanceId: 'inst-1', clientRequestId: 'req-1', receipt: { state: 'queued' } });
  const seen = await ledger.replayByRequest({ identity: IDENTITY, requestId: 'req-1' });
  assert.equal(seen.receipt.state, 'submitted', '乱序到达的旧回执必须被忽略');
});

// —— 审批待办的行为契约 ——

const TARGET = { instanceId: 'inst-1', threadId: 'thr-1', turnId: 'turn-1', itemId: 'item-1', requestId: 'rq-1' };

// responder 的契约是「返回字面量 true 表示决定已下发给 runtime」，真实调用点回的是
// ai.respondApproval(...) 的布尔值。这里的桩曾经返回 { ok: true } —— truthy 但不是
// true，于是记录被判成 revoked，下面两条测试整个跑在失败分支上：「处理后消失」之所以
// 绿是因为 revoked 也会从快照消失，「只执行一次」之所以绿是因为第二次撞到 stale 而
// 不是 duplicate。成功路径一次都没被验证过，坏了也不会红。所以除了返回值，还要断言
// outcome.kind —— 它能区分「走对了分支」和「碰巧结果一样」。
const acceptResponder = async () => true;

test('契约：待办出现在快照里，成功处理后消失且记为 resolved', async () => {
  const registry = new NeedsYouRegistry();
  registry.open({ kind: 'approval', target: TARGET, payload: { command: 'rm -rf /' } });
  assert.equal(registry.snapshot().needs.length, 1, '重连的手机要能看到待办');
  assert.equal(registry.snapshot().needs[0].payload.command, 'rm -rf /',
    '卡片内容必须能重建——协议侧的 server request 是一次性的，重连后取不回来');

  const outcome = await registry.resolve(TARGET, { decision: 'approved' }, acceptResponder);
  assert.equal(outcome.kind, 'resolved', '决定成功下发要记成 resolved，而不是 stale/revoked');
  assert.equal(registry.snapshot().needs.length, 0, '处理完不该继续出现在待办里');
});

test('契约：同一审批被处理两次，只执行一次决定并报 duplicate', async () => {
  const registry = new NeedsYouRegistry();
  registry.open({ kind: 'approval', target: TARGET, payload: {} });
  let responderCalls = 0;
  const responder = async () => { responderCalls += 1; return true; };

  const first = await registry.resolve(TARGET, { decision: 'approved' }, responder);
  const second = await registry.resolve(TARGET, { decision: 'approved' }, responder);
  assert.equal(first.kind, 'resolved');
  assert.equal(second.kind, 'duplicate', '重复处理要能被认出是同一个决定，而不是当成过期');
  assert.equal(responderCalls, 1, '第二次不得再次下发决定');
});

test('契约：同一审批换了不同决定要报 conflict，不能静默覆盖', async () => {
  const registry = new NeedsYouRegistry();
  registry.open({ kind: 'approval', target: TARGET, payload: {} });
  let responderCalls = 0;
  const responder = async () => { responderCalls += 1; return true; };

  await registry.resolve(TARGET, { decision: 'approved' }, responder);
  const conflicting = await registry.resolve(TARGET, { decision: 'denied' }, responder);
  assert.equal(conflicting.kind, 'conflict',
    '两台设备对同一条审批点了不同的按钮，后一台必须被明确告知，而不是以为自己生效了');
  assert.equal(responderCalls, 1, '相反的决定绝不能也下发一次');
});

test('契约：runtime 拒收决定时待办不留在待处理里，也不算成功', async () => {
  const registry = new NeedsYouRegistry();
  registry.open({ kind: 'approval', target: TARGET, payload: {} });

  // runtime 已经不在了（实例被回收、turn 结束），respondApproval 返回 false。
  const outcome = await registry.resolve(TARGET, { decision: 'approved' }, async () => false);
  assert.equal(outcome.kind, 'stale', '下发失败不能报成 resolved');
  assert.equal(registry.snapshot().needs.length, 0,
    '也不能继续挂在待办里让用户反复点一个永远不会生效的按钮');
});

test('契约：下发过程抛错时标成 unknown 并留在快照里等人处理', async () => {
  const registry = new NeedsYouRegistry();
  registry.open({ kind: 'approval', target: TARGET, payload: {} });

  const outcome = await registry.resolve(TARGET, { decision: 'approved' }, async () => {
    throw new Error('transport died');
  });
  assert.equal(outcome.kind, 'unknown',
    '结果未知与「确定失败」必须分开：前者可能已经生效了，不能当成没发生');
  assert.equal(registry.snapshot().needs.length, 1,
    'unknown 要继续出现在待办里 —— 用户需要看到「这条还没定论」，而不是它悄悄消失');
});

test('契约：处理一个不存在的审批是 stale，不是崩溃', async () => {
  const registry = new NeedsYouRegistry();
  const outcome = await registry.resolve(TARGET, { decision: 'approved' }, async () => ({ ok: true }));
  assert.equal(outcome.kind, 'stale');
});

test('契约：撤销后的待办不再可处理', async () => {
  const registry = new NeedsYouRegistry();
  registry.open({ kind: 'approval', target: TARGET, payload: {} });
  registry.close(TARGET, { state: 'revoked' });
  assert.equal(registry.snapshot().needs.length, 0);

  let called = false;
  await registry.resolve(TARGET, { decision: 'approved' }, async () => { called = true; return { ok: true }; });
  assert.equal(called, false, '已撤销的审批不得再下发决定');
});

test('契约：被遗弃的排队消息不会永久占住账本', async () => {
  let clock = 1000;
  const ledger = new MessageReceiptLedger({ maxEntries: 3, ttlMs: 60_000, now: () => clock });

  // 三条消息进了 runtime 队列，随后 turn 被放弃 —— 实例空闲被回收、codex 退出、
  // 或者 thread 被关掉。终态回执由 agent 的事件驱动，这些情况下它永远不会到来。
  for (const requestId of ['a', 'b', 'c']) {
    const claim = ledger.claim({ identity: IDENTITY, requestId, fingerprint: 'fp' });
    ledger.bindRuntime(claim.handle, { instanceId: 'inst-1', clientRequestId: requestId });
    ledger.settle(claim.handle, { ok: true, receipt: { state: 'queued' } });
  }

  clock += 10 * 24 * 60 * 60 * 1000; // 十天以后

  const fresh = ledger.claim({ identity: IDENTITY, requestId: 'today', fingerprint: 'fp' });
  assert.equal(
    fresh.kind,
    'owner',
    '十天前被遗弃的排队消息不该让今天的新消息发不出去。账本满时服务端回 '
    + 'receipt_ledger_full 并告诉用户「请稍后重试」，但如果这些条目永远不回收，'
    + '「稍后」永远不会到来 —— 所有带 clientRequestId 的消息会一直失败到进程重启。',
  );
});

test('契约：还在排队的近期消息不会被回收，重连仍查得到', async () => {
  let clock = 1000;
  const ledger = new MessageReceiptLedger({ maxEntries: 10, ttlMs: 60_000, now: () => clock });
  const claim = ledger.claim({ identity: IDENTITY, requestId: 'queued-now', fingerprint: 'fp' });
  ledger.bindRuntime(claim.handle, { instanceId: 'inst-1', clientRequestId: 'queued-now' });
  ledger.settle(claim.handle, { ok: true, receipt: { state: 'queued' } });

  // 超过普通 ttl，但远没到「被遗弃」的宽限期。消息可能还真排在队列里。
  clock += 60_000 * 5;
  ledger.prune();

  const seen = await ledger.replayByRequest({ identity: IDENTITY, requestId: 'queued-now' });
  assert.equal(seen?.receipt?.state, 'queued',
    '排队中的消息被过早回收会让重连的客户端查不到回执，进而重复发送同一条消息');
});
