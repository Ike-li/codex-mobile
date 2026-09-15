import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindThreadFromEvent,
  eventMatchesTarget,
  outboxRequestMatchesView,
  withTarget,
} from '../../public/js/view-routing.js';

test('eventMatchesTarget rejects a foreign thread event before rendering', () => {
  const target = { instanceId: 'inst_a', threadId: 'thr_a' };

  assert.equal(eventMatchesTarget({
    type: 'text_delta',
    instanceId: 'inst_b',
    sessionId: 'thr_b',
    payload: { text: 'foreign' },
  }, target), false);

  assert.equal(eventMatchesTarget({
    type: 'text_delta',
    instanceId: 'inst_a',
    sessionId: 'thr_a',
    payload: { text: 'current' },
  }, target), true);
});

test('eventMatchesTarget allows host-level control events for every view', () => {
  const target = { instanceId: 'inst_a', threadId: 'thr_a' };

  for (const type of [
    'device_status',
    'instances',
    'pending_devices',
    'status_line',
    'account_login',
    'account_updated',
    'rate_limits',
    'mcp_status',
    'skills_changed',
    'external_agent_config_import',
    'remote_control',
  ]) {
    assert.equal(eventMatchesTarget({ type, epoch: 'server', seq: 0, payload: {} }, target), true, type);
  }
});

test('eventMatchesTarget exposes host-scoped thread status to every view while isolating runtime status', () => {
  const targetA = { instanceId: 'inst_a', threadId: 'thr_a' };
  const targetB = { instanceId: 'inst_b', threadId: 'thr_b' };
  const hostStatus = {
    type: 'thread_status',
    instanceId: null,
    sessionId: null,
    payload: { scope: 'host', threadId: 'thr_external', status: 'active' },
  };

  assert.equal(eventMatchesTarget(hostStatus, targetA), true);
  assert.equal(eventMatchesTarget(hostStatus, targetB), true);

  const runtimeStatus = {
    type: 'thread_status',
    instanceId: 'inst_a',
    sessionId: 'thr_a',
    payload: { threadId: 'thr_a', status: 'active' },
  };
  assert.equal(eventMatchesTarget(runtimeStatus, targetA), true);
  assert.equal(eventMatchesTarget(runtimeStatus, targetB), false);
});

test('eventMatchesTarget rejects the retired session_list event', () => {
  assert.equal(eventMatchesTarget({
    type: 'session_list',
    epoch: 'server',
    seq: 0,
    payload: {},
  }, { instanceId: 'inst_a', threadId: 'thr_a' }), false);
});

test('eventMatchesTarget accepts a control-agent event addressed to the current thread', () => {
  const target = { instanceId: 'inst_live', threadId: 'thr_a' };

  assert.equal(eventMatchesTarget({
    type: 'compact',
    instanceId: 'inst_control',
    sessionId: null,
    payload: { threadId: 'thr_a' },
  }, target), true);
  assert.equal(eventMatchesTarget({
    type: 'compact',
    instanceId: 'inst_control',
    sessionId: null,
    payload: { threadId: 'thr_b' },
  }, target), false);
});

test('withTarget freezes the current instance and thread onto an outgoing command', () => {
  assert.deepEqual(withTarget(
    { text: 'hello' },
    { instanceId: 'inst_a', threadId: 'thr_a' },
  ), {
    text: 'hello',
    instanceId: 'inst_a',
    threadId: 'thr_a',
  });
});

test('bindThreadFromEvent binds only the matching provisional instance', () => {
  const provisional = { instanceId: 'inst_new', threadId: null };

  assert.deepEqual(bindThreadFromEvent(provisional, {
    instanceId: 'inst_foreign', sessionId: 'thr_foreign',
  }), provisional);
  assert.deepEqual(bindThreadFromEvent(provisional, {
    instanceId: 'inst_new', sessionId: 'thr_new',
  }), { instanceId: 'inst_new', threadId: 'thr_new' });
});

test('eventMatchesTarget allows the initial scoped init before a target is restored', () => {
  assert.equal(eventMatchesTarget({
    type: 'init',
    instanceId: 'inst_restored',
    sessionId: 'thr_restored',
    payload: { sessionId: 'thr_restored' },
  }, { instanceId: null, threadId: null }), true);
});

// ---------------------------------------------------------------------------
// outboxRequestMatchesView —— 出站方向的视图路由。
//
// 从 app.js 抽出来的。此前它只被 public-ui.test.mjs 用一条
// `assert.match(syncBody, /shouldSend: outboxRequestMatchesView/)` "覆盖"着 ——
// 那条断言只证明这个名字出现在源码里，对它**判得对不对**一无所知。
// 而判错的后果是排队消息发到错误的 thread：用户看不到自己发的话，或者更糟，
// 一条消息出现在另一个会话里。
// ---------------------------------------------------------------------------

test('已绑定 thread 的排队请求只属于同一个 thread 的视图', () => {
  const request = { payload: { threadId: 'thr_a', instanceId: 'inst_a' } };

  assert.equal(outboxRequestMatchesView(request, { threadId: 'thr_a', instanceId: 'inst_a' }), true);
  assert.equal(outboxRequestMatchesView(request, { threadId: 'thr_b', instanceId: 'inst_a' }), false);
});

test('threadId 的优先级高于 instanceId —— 同实例不同 thread 不算同一个视图', () => {
  // 这是最容易写反的一处：一个 instance 上可以先后开多个 thread。
  // 若先比 instanceId，切到同实例的新 thread 后，旧 thread 的排队消息会被当成
  // "属于当前视图"而发出去，落到错误的会话里。
  const request = { payload: { threadId: 'thr_old', instanceId: 'inst_a' } };

  assert.equal(outboxRequestMatchesView(request, { threadId: 'thr_new', instanceId: 'inst_a' }), false);
});

test('尚未绑定 thread 的请求按 instanceId 归属', () => {
  const request = { payload: { instanceId: 'inst_a' } };

  assert.equal(outboxRequestMatchesView(request, { threadId: null, instanceId: 'inst_a' }), true);
  assert.equal(outboxRequestMatchesView(request, { threadId: null, instanceId: 'inst_b' }), false);
  // 视图已经绑定到某个 thread 时，一条还没有 thread 的请求不该被算作它的。
  assert.equal(outboxRequestMatchesView(request, { threadId: 'thr_a', instanceId: 'inst_a' }), true);
});

test('两者都没有的请求只属于同样未绑定的视图', () => {
  const unbound = { payload: {} };

  assert.equal(outboxRequestMatchesView(unbound, { threadId: null, instanceId: null }), true);
  assert.equal(outboxRequestMatchesView(unbound, { threadId: 'thr_a', instanceId: null }), false);
  assert.equal(outboxRequestMatchesView(unbound, { threadId: null, instanceId: 'inst_a' }), false);
});

test('缺失或畸形的请求不会抛异常，按未绑定处理', () => {
  // outbox 记录来自 IndexedDB，可能是旧版本写入的、缺字段的。
  // 抛异常会中断整轮 drain，让**所有**排队消息卡住，而不只是这一条。
  for (const bad of [null, undefined, {}, { payload: null }]) {
    assert.equal(outboxRequestMatchesView(bad, { threadId: null, instanceId: null }), true);
    assert.equal(outboxRequestMatchesView(bad, { threadId: 'thr_a', instanceId: null }), false);
  }
});
