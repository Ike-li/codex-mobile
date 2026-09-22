import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bufferRecoveryEvent,
  completeRecovery,
  createRecoveryState,
} from '../../public/js/outbox/recovery-state.js';

test('recovery accepts only its exact target and flushes live events above the snapshot watermark', () => {
  const recovery = createRecoveryState({ instanceId: 'inst-a', threadId: 'thr-a' });
  assert.equal(bufferRecoveryEvent(recovery, {
    seq: 9, epoch: 'epoch-a', instanceId: 'inst-b', sessionId: 'thr-b', type: 'text_delta',
  }), false);
  assert.equal(bufferRecoveryEvent(recovery, {
    seq: 10, epoch: 'epoch-a', instanceId: 'inst-a', sessionId: 'thr-a', type: 'text_delta',
  }), true);
  assert.equal(bufferRecoveryEvent(recovery, {
    seq: 12, epoch: 'epoch-a', instanceId: 'inst-a', sessionId: 'thr-a', type: 'result',
  }), true);

  const completed = completeRecovery(recovery, {
    gap: true,
    rebuilt: true,
    instanceId: 'inst-a',
    threadId: 'thr-a',
    epoch: 'epoch-a',
    throughSeq: 10,
    snapshot: { source: 'thread/read', messages: [] },
  });
  assert.equal(completed.accepted, true);
  assert.deepEqual(completed.events.map(event => event.seq), [12]);

  const switched = completeRecovery(recovery, {
    gap: true,
    rebuilt: true,
    instanceId: 'inst-b',
    threadId: 'thr-a',
    epoch: 'epoch-a',
    throughSeq: 10,
    snapshot: { source: 'thread/read', messages: [] },
  });
  assert.equal(switched.accepted, false);
});

// 恢复缓冲的每一条拒绝规则都对应一种用户看得见的损坏：串台的事件会让另一个实例的
// 消息出现在当前对话里，来源不明的快照会让历史被一段伪造内容替换，去重失效会让
// 同一条消息出现两遍，watermark 用错会让刚补回来的内容又被丢掉。
function evt(seq, over = {}) {
  return { seq, epoch: 'e1', instanceId: 'inst-a', sessionId: 'thr-a', ...over };
}

test('缓冲拒绝没有有效 seq 的事件——没有序号就无法定位和去重', () => {
  const recovery = createRecoveryState({ instanceId: 'inst-a', threadId: 'thr-a' });
  for (const bad of [{ seq: 0 }, { seq: -1 }, { seq: 'x' }, { seq: undefined }, { seq: null }]) {
    assert.equal(bufferRecoveryEvent(recovery, { ...evt(1), ...bad }), false);
  }
  assert.equal(bufferRecoveryEvent(recovery, null), false);
  assert.equal(bufferRecoveryEvent(null, evt(1)), false);
  assert.equal(recovery.events.length, 0);
});

test('缓冲拒绝别的实例和别的 thread 的事件——串台等于把另一个对话混进来', () => {
  const recovery = createRecoveryState({ instanceId: 'inst-a', threadId: 'thr-a' });
  assert.equal(bufferRecoveryEvent(recovery, evt(1, { instanceId: 'inst-b' })), false);
  assert.equal(bufferRecoveryEvent(recovery, evt(2, { sessionId: 'thr-b' })), false);
  assert.equal(bufferRecoveryEvent(recovery, evt(3)), true);
  assert.deepEqual(recovery.events.map(e => e.seq), [3]);
});

test('缓冲能从 payload.threadId 认出归属，兼容没有顶层 sessionId 的事件', () => {
  const recovery = createRecoveryState({ instanceId: 'inst-a', threadId: 'thr-a' });
  assert.equal(bufferRecoveryEvent(recovery, evt(1, { sessionId: null, payload: { threadId: 'thr-a' } })), true);
  assert.equal(bufferRecoveryEvent(recovery, evt(2, { sessionId: null, payload: { threadId: 'thr-b' } })), false);
  assert.deepEqual(recovery.events.map(e => e.seq), [1]);
});

test('没有指定目标的恢复状态接收任何实例的事件', () => {
  const loose = createRecoveryState();
  assert.equal(loose.instanceId, null);
  assert.equal(loose.threadId, null);
  assert.equal(bufferRecoveryEvent(loose, evt(1, { instanceId: 'anything' })), true);
});

test('ack 目标对不上就整体拒绝，不能把别人的补包当成自己的', () => {
  const recovery = createRecoveryState({ instanceId: 'inst-a', threadId: 'thr-a' });
  bufferRecoveryEvent(recovery, evt(1));
  for (const ack of [
    { instanceId: 'inst-b', threadId: 'thr-a' },
    { instanceId: 'inst-a', threadId: 'thr-b' },
    {},
  ]) {
    assert.deepEqual(completeRecovery(recovery, ack), { accepted: false, events: [] });
  }
  assert.deepEqual(completeRecovery(null, { instanceId: 'inst-a', threadId: 'thr-a' }), { accepted: false, events: [] });
});

test('重建快照必须来自 thread/read，其他来源一律拒绝', () => {
  const recovery = createRecoveryState({ instanceId: 'inst-a', threadId: 'thr-a' });
  bufferRecoveryEvent(recovery, evt(5));
  const base = { instanceId: 'inst-a', threadId: 'thr-a', gap: true, rebuilt: true, throughSeq: 3 };

  assert.deepEqual(
    completeRecovery(recovery, { ...base, snapshot: { source: 'event-buffer' } }),
    { accepted: false, events: [] },
    '来源不是 thread/read 就不能拿它替换历史',
  );
  assert.deepEqual(completeRecovery(recovery, { ...base, snapshot: {} }), { accepted: false, events: [] });
  assert.deepEqual(completeRecovery(recovery, base), { accepted: false, events: [] }, '连 snapshot 都没有更不行');

  const ok = completeRecovery(recovery, { ...base, snapshot: { source: 'thread/read' } });
  assert.equal(ok.accepted, true);
  assert.equal(ok.rebuilt, true);
});

test('重建后丢弃 watermark 及以下的缓冲事件，避免和快照内容重复', () => {
  const recovery = createRecoveryState({ instanceId: 'inst-a', threadId: 'thr-a' });
  for (const seq of [2, 3, 4, 5]) bufferRecoveryEvent(recovery, evt(seq));

  const result = completeRecovery(recovery, {
    instanceId: 'inst-a', threadId: 'thr-a',
    gap: true, rebuilt: true, throughSeq: 3,
    snapshot: { source: 'thread/read' },
    epoch: 'e1',
  });
  assert.deepEqual(result.events.map(e => e.seq), [4, 5], '≤3 的已经在快照里了');
  assert.equal(result.throughSeq, 3);
  assert.equal(result.epoch, 'e1');
});

test('非重建的普通补发保留全部缓冲事件，并按 seq 排序去重', () => {
  const recovery = createRecoveryState({ instanceId: 'inst-a', threadId: 'thr-a' });
  for (const seq of [3, 1, 2, 1]) bufferRecoveryEvent(recovery, evt(seq));

  const result = completeRecovery(recovery, { instanceId: 'inst-a', threadId: 'thr-a', gap: false });
  assert.deepEqual(result.events.map(e => e.seq), [1, 2, 3], '乱序到达要排好，重复的 seq 只留一份');
  assert.equal(result.rebuilt, false);
  assert.equal(result.snapshot, null);
  assert.equal(result.throughSeq, null);
});

test('同一个 seq 在不同 epoch 下不算重复——换代之后序号会从头开始', () => {
  const recovery = createRecoveryState({ instanceId: 'inst-a', threadId: 'thr-a' });
  bufferRecoveryEvent(recovery, evt(1, { epoch: 'e1' }));
  bufferRecoveryEvent(recovery, evt(1, { epoch: 'e2' }));

  const result = completeRecovery(recovery, { instanceId: 'inst-a', threadId: 'thr-a' });
  assert.equal(result.events.length, 2, '按 epoch:seq 去重，跨代的同号事件都要留下');
});

test('gap 为真但没重建时，throughSeq 不生效，缓冲一条不丢', () => {
  const recovery = createRecoveryState({ instanceId: 'inst-a', threadId: 'thr-a' });
  for (const seq of [1, 2, 3]) bufferRecoveryEvent(recovery, evt(seq));

  const result = completeRecovery(recovery, {
    instanceId: 'inst-a', threadId: 'thr-a',
    gap: true, rebuilt: false, throughSeq: 2, snapshot: { source: 'thread/read' },
  });
  assert.equal(result.gap, true);
  assert.equal(result.rebuilt, false);
  assert.deepEqual(result.events.map(e => e.seq), [1, 2, 3], '没有快照兜底就不能按 watermark 丢东西');
});

// ---- 变异补漏：批 3 ----

// 标识符归一化：非字符串一律变 null。留下原值会让下游的相等比较拿数字去和字符串比，
// bufferRecoveryEvent 的 `event.instanceId !== recovery.instanceId` 就会永远为真——
// 重建期间到达的事件全部被丢掉，而没有任何报错。
test('createRecoveryState 把非字符串标识符归一成 null，不原样留下', () => {
  assert.deepEqual(createRecoveryState({ instanceId: 123, threadId: '' }), {
    instanceId: null, threadId: null, events: [],
  });
  assert.deepEqual(createRecoveryState({ instanceId: 'inst-1', threadId: 'thr-1' }), {
    instanceId: 'inst-1', threadId: 'thr-1', events: [],
  });
  assert.deepEqual(createRecoveryState(), { instanceId: null, threadId: null, events: [] });
});

// throughSeq 是「快照已经覆盖到哪一条」的水位线，客户端据它决定丢弃哪些暂存事件。
// 重建时对方没给出合法的 throughSeq，必须回落到 -1（含义：一条都不丢），
// 而不是把 undefined 传下去——`seq <= undefined` 恒为 false，看着也"没丢事件"，
// 但返回值里的水位线就成了 undefined，调用方拿它再做判断时行为不可预期。
test('重建时 throughSeq 非法则回落到 -1，不把 undefined 当水位线传下去', () => {
  const recovery = createRecoveryState({ instanceId: 'inst-1', threadId: 'thr-1' });
  bufferRecoveryEvent(recovery, { seq: 5, epoch: 'e1', instanceId: 'inst-1', sessionId: 'thr-1' });

  const result = completeRecovery(recovery, {
    instanceId: 'inst-1',
    threadId: 'thr-1',
    gap: true,
    rebuilt: true,
    snapshot: { source: 'thread/read' },
    // throughSeq 缺失
  });

  assert.equal(result.accepted, true);
  assert.equal(result.throughSeq, -1, '拿不到合法水位线时回落到 -1（一条都不丢）');
  assert.deepEqual(result.events.map(event => event.seq), [5], '暂存的事件不该被丢掉');
});
