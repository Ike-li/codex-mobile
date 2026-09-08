import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMessageOutbox } from '../public/js/message-outbox.js';
import { createMessageRequest } from '../public/js/message-request.js';

test('message outbox persists a request before its first transport attempt', async () => {
  const calls = [];
  let stored = [];
  const store = {
    async put(record) {
      calls.push(`put:${record.state}`);
      stored = [structuredClone(record)];
    },
    async list() {
      calls.push('list');
      return structuredClone(stored);
    },
  };
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      calls.push(`send:${payload.clientRequestId}`);
      return { ok: true, receipt: { state: 'submitted' } };
    },
  });
  const request = createMessageRequest({
    text: 'persist first',
    target: { threadId: 'thr-outbox' },
  }, { createId: () => 'req-persist-first', now: () => 1 });

  await outbox.enqueue(request);
  await outbox.drain();

  assert.ok(calls.indexOf('put:pending') < calls.indexOf('send:req-persist-first'));
});

test('message outbox deletes a request after a submitted duplicate receipt', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport() {
      return {
        ok: true,
        duplicate: true,
        receipt: { clientRequestId: 'req-accepted', state: 'submitted' },
      };
    },
  });
  const request = createMessageRequest({
    text: 'already accepted',
    target: { threadId: 'thr-outbox' },
  }, { createId: () => 'req-accepted', now: () => 2 });

  await outbox.enqueue(request);
  await outbox.drain();

  assert.deepEqual(await store.list(), []);
});

test('message outbox quarantines an unknown timeout for reconciliation without replaying it', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  let transportCalls = 0;
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport() {
      transportCalls += 1;
      const error = new Error('ack timeout');
      error.code = 'ack_timeout';
      error.retryable = true;
      error.resultUnknown = true;
      throw error;
    },
  });
  const request = createMessageRequest({
    text: 'retry exactly this',
    target: { threadId: 'thr-retry' },
  }, { createId: () => 'req-retryable', now: () => 3 });
  const originalPayload = structuredClone(request.payload);

  await outbox.enqueue(request);
  await assert.doesNotReject(outbox.drain());
  await assert.doesNotReject(outbox.drain());

  const [retained] = await store.list();
  assert.equal(retained.state, 'needs_reconcile');
  assert.equal(retained.attempts, 1);
  assert.equal(transportCalls, 1);
  assert.deepEqual(retained.lastError, {
    code: 'ack_timeout',
    message: 'ack timeout',
    resultUnknown: true,
  });
  assert.deepEqual(retained.payload, originalPayload);
});

test('message outbox reconciles an unknown request read-only before removing it', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  let messageSends = 0;
  const reconcileQueries = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    getGatewayEpoch: () => 'gateway-epoch-a',
    async transport() {
      messageSends += 1;
      const error = new Error('ack lost after dispatch');
      error.code = 'ack_timeout';
      error.retryable = true;
      error.resultUnknown = true;
      throw error;
    },
    async reconcileTransport(query) {
      reconcileQueries.push(structuredClone(query));
      return {
        ok: true,
        resolved: true,
        gatewayEpoch: 'gateway-epoch-b',
        receipt: {
          clientRequestId: query.clientRequestId,
          threadId: query.threadId,
          state: 'submitted',
        },
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'reconcile me', target: { threadId: 'thr-reconcile-me' },
  }, { createId: () => 'req-reconcile-me', now: () => 4 }));

  await outbox.drain();
  const [unknown] = await store.list();
  assert.equal(unknown.state, 'needs_reconcile');
  assert.equal(unknown.attemptedGatewayEpoch, 'gateway-epoch-a');

  const result = await outbox.reconcile();

  assert.deepEqual(result, { checked: 1, resolved: 1, unresolved: 0 });
  assert.equal(messageSends, 1);
  assert.deepEqual(reconcileQueries, [{
    clientRequestId: 'req-reconcile-me',
    threadId: 'thr-reconcile-me',
    attemptedGatewayEpoch: 'gateway-epoch-a',
  }]);
  assert.deepEqual(await store.list(), []);
});

test('message outbox reconciles a queued receipt when the gateway epoch changes', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const queries = [];
  let messageSends = 0;
  await store.put({
    ...createMessageRequest({
      text: 'queued on the old gateway', target: { threadId: 'thr-old-queue' },
    }, { createId: () => 'req-old-queue', now: () => 5 }),
    state: 'queued',
    attemptedGatewayEpoch: 'gateway-old',
    receipt: {
      clientRequestId: 'req-old-queue',
      threadId: 'thr-old-queue',
      state: 'queued',
    },
  });
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    getGatewayEpoch: () => 'gateway-new',
    async transport() { messageSends += 1; },
    async reconcileTransport(query) {
      queries.push(structuredClone(query));
      return {
        ok: true,
        resolved: false,
        gatewayEpoch: 'gateway-new',
        resultUnknown: true,
        errorCode: 'client_request_not_found',
      };
    },
  });

  const result = await outbox.reconcile();

  assert.deepEqual(result, { checked: 1, resolved: 0, unresolved: 1 });
  assert.equal(messageSends, 0);
  assert.deepEqual(queries, [{
    clientRequestId: 'req-old-queue',
    threadId: 'thr-old-queue',
    attemptedGatewayEpoch: 'gateway-old',
  }]);
  const [record] = await store.list();
  assert.equal(record.state, 'needs_reconcile');
  assert.equal(record.reconciledGatewayEpoch, 'gateway-new');
});

test('message outbox reconciles a queued receipt after a same-epoch view switch', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  await store.put({
    clientRequestId: 'req-queued-same-epoch',
    createdAt: 1,
    state: 'queued',
    attemptedGatewayEpoch: 'gateway-stable',
    payload: {
      clientRequestId: 'req-queued-same-epoch',
      text: 'queued while another view opens',
      threadId: 'thr-queued-same-epoch',
    },
  });
  const queries = [];
  const outbox = createMessageOutbox({
    store,
    transport: async () => assert.fail('queued reconciliation must stay read-only'),
    isConnected: () => true,
    getGatewayEpoch: () => 'gateway-stable',
    async reconcileTransport(query) {
      queries.push(query);
      return {
        ok: true,
        resolved: true,
        receipt: {
          clientRequestId: query.clientRequestId,
          state: 'submitted',
          threadId: query.threadId,
        },
      };
    },
  });

  const summary = await outbox.reconcile();

  assert.deepEqual(summary, { checked: 1, resolved: 1, unresolved: 0 });
  assert.deepEqual(queries, [{
    clientRequestId: 'req-queued-same-epoch',
    threadId: 'thr-queued-same-epoch',
    attemptedGatewayEpoch: 'gateway-stable',
  }]);
  assert.deepEqual(await store.list(), []);
});

test('message outbox records a definitive reconciled rejection without replaying it', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  await store.put({
    ...createMessageRequest({
      text: 'rejected upstream', target: { threadId: 'thr-rejected-upstream' },
    }, { createId: () => 'req-rejected-upstream', now: () => 6 }),
    state: 'needs_reconcile',
  });
  let messageSends = 0;
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport() { messageSends += 1; },
    async reconcileTransport() {
      return {
        ok: true,
        resolved: true,
        gatewayEpoch: 'gateway-current',
        outcome: {
          ok: false,
          errorCode: 'dispatch_rejected',
          error: 'runtime rejected the message',
          retryable: false,
          resultUnknown: false,
        },
      };
    },
  });

  const result = await outbox.reconcile();

  assert.deepEqual(result, { checked: 1, resolved: 1, unresolved: 0 });
  assert.equal(messageSends, 0);
  const [record] = await store.list();
  assert.equal(record.state, 'rejected');
  assert.deepEqual(record.lastError, {
    code: 'dispatch_rejected',
    message: 'runtime rejected the message',
    resultUnknown: false,
  });
});

test('message outbox retries an unknown result only after explicit confirmation', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  await store.put({
    ...createMessageRequest({
      text: 'confirm before retry', target: { threadId: 'thr-confirm-retry' },
    }, { createId: () => 'req-confirm-retry', now: () => 7 }),
    state: 'needs_reconcile',
    attempts: 1,
  });
  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    getGatewayEpoch: () => 'gateway-after-confirmation',
    createId: () => 'req-confirm-retry-replacement',
    now: () => 1234,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      return {
        ok: true,
        receipt: {
          clientRequestId: payload.clientRequestId,
          threadId: payload.threadId,
          state: 'submitted',
        },
      };
    },
  });

  await outbox.drain();
  assert.deepEqual(sent, []);
  const replacement = await outbox.retryAfterConfirmation('req-confirm-retry', {
    confirmedAt: 1234,
    target: { threadId: 'thr-confirm-retry' },
  });
  assert.equal(replacement.clientRequestId, 'req-confirm-retry-replacement');
  assert.equal(replacement.retryOfClientRequestId, 'req-confirm-retry');
  await outbox.drain();

  assert.deepEqual(sent, ['req-confirm-retry-replacement']);
  assert.deepEqual(await store.list(), []);
});

test('message outbox rebinds only a never-attempted provisional request without changing its id', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  await store.put(createMessageRequest({
    text: 'recover provisional target',
    attachments: [{ name: 'note.txt', mimeType: 'text/plain', data: 'bm90ZQ==' }],
    target: { instanceId: 'inst-dead' },
  }, { createId: () => 'req-rebind-same-id', now: () => 77 }));
  await store.put({
    ...createMessageRequest({
      text: 'attempted target stays quarantined', target: { instanceId: 'inst-dead' },
    }, { createId: () => 'req-attempted-orphan', now: () => 78 }),
    state: 'needs_reconcile',
    attempts: 1,
  });
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport() { assert.fail('rebinding must not dispatch'); },
  });

  const rebound = await outbox.rebindUnattempted('req-rebind-same-id', {
    threadId: 'thr-current',
    instanceId: 'inst-current',
  });
  const refused = await outbox.rebindUnattempted('req-attempted-orphan', {
    threadId: 'thr-current',
  });

  assert.equal(rebound.clientRequestId, 'req-rebind-same-id');
  assert.equal(rebound.createdAt, 77);
  assert.deepEqual(rebound.payload, {
    clientRequestId: 'req-rebind-same-id',
    text: 'recover provisional target',
    attachments: [{ name: 'note.txt', mimeType: 'text/plain', data: 'bm90ZQ==' }],
    threadId: 'thr-current',
  });
  assert.equal(refused, null);
  const attempted = (await store.list()).find(record => record.clientRequestId === 'req-attempted-orphan');
  assert.equal(attempted.state, 'needs_reconcile');
  assert.equal(attempted.payload.instanceId, 'inst-dead');
});

test('confirmed retry cannot race with reconciliation and resurrect the quarantined id', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  await store.put({
    ...createMessageRequest({
      text: 'serialize retry and reconcile', target: { instanceId: 'inst-dead' },
    }, { createId: () => 'req-race-old', now: () => 79 }),
    state: 'needs_reconcile',
    attempts: 1,
  });
  let releaseReconcile;
  let reconciliationStarted;
  const started = new Promise(resolve => { reconciliationStarted = resolve; });
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    createId: () => 'req-race-replacement',
    async transport() { assert.fail('the race test must stay read-only'); },
    async reconcileTransport() {
      reconciliationStarted();
      await new Promise(resolve => { releaseReconcile = resolve; });
      return { ok: true, resolved: false, resultUnknown: true };
    },
  });

  const reconciling = outbox.reconcile();
  await started;
  const retrying = outbox.retryAfterConfirmation('req-race-old', {
    target: { threadId: 'thr-current' },
  });
  releaseReconcile();
  const [, replacement] = await Promise.all([reconciling, retrying]);

  assert.equal(replacement.clientRequestId, 'req-race-replacement');
  assert.deepEqual((await store.list()).map(record => record.clientRequestId), [
    'req-race-replacement',
  ]);
});

test('message outbox drains in FIFO order through one shared flight', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() {
      return [...records.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(record => structuredClone(record));
    },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const sent = [];
  const firstResolvers = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    transport(payload) {
      sent.push(payload.clientRequestId);
      if (payload.clientRequestId === 'req-first') {
        return new Promise(resolve => firstResolvers.push(resolve));
      }
      return Promise.resolve({
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' },
      });
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'first', target: { threadId: 'thr-fifo' },
  }, { createId: () => 'req-first', now: () => 10 }));
  await outbox.enqueue(createMessageRequest({
    text: 'second', target: { threadId: 'thr-fifo' },
  }, { createId: () => 'req-second', now: () => 20 }));

  const drainA = outbox.drain();
  const drainB = outbox.drain();
  await new Promise(resolve => setImmediate(resolve));
  const sentBeforeFirstAck = [...sent];
  for (const resolve of firstResolvers) {
    resolve({ ok: true, receipt: { clientRequestId: 'req-first', state: 'submitted' } });
  }
  await Promise.all([drainA, drainB]);

  assert.deepEqual(sentBeforeFirstAck, ['req-first']);
  assert.deepEqual(sent, ['req-first', 'req-second']);
  assert.deepEqual(await store.list(), []);
});

test('message outbox schedules a follow-up drain for input enqueued during an active flight', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() {
      return [...records.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(record => structuredClone(record));
    },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const sent = [];
  let releaseFirst;
  const firstAck = new Promise(resolve => { releaseFirst = resolve; });
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      if (payload.clientRequestId === 'req-active-first') await firstAck;
      return {
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' },
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'first active request', target: { threadId: 'thr-active-flight' },
  }, { createId: () => 'req-active-first', now: () => 21 }));

  const firstDrain = outbox.drain({
    shouldSend: request => request.clientRequestId === 'req-active-first',
  });
  await new Promise(resolve => setImmediate(resolve));
  await outbox.enqueue(createMessageRequest({
    text: 'arrived during active request', target: { threadId: 'thr-active-flight' },
  }, { createId: () => 'req-active-second', now: () => 22 }));
  const secondDrain = outbox.drain({
    shouldSend: request => request.clientRequestId === 'req-active-second',
  });
  releaseFirst();

  await Promise.all([firstDrain, secondDrain]);

  assert.deepEqual(sent, ['req-active-first', 'req-active-second']);
  assert.deepEqual(await store.list(), []);
});

test('message outbox records an explicit rejection and does not skip ahead in FIFO order', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() {
      return [...records.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(record => structuredClone(record));
    },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      return {
        ok: false,
        errorCode: 'stale_target',
        error: 'message target is stale',
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'blocked first', target: { threadId: 'thr-stale' },
  }, { createId: () => 'req-rejected', now: () => 30 }));
  await outbox.enqueue(createMessageRequest({
    text: 'must wait', target: { threadId: 'thr-stale' },
  }, { createId: () => 'req-waiting', now: () => 40 }));

  await outbox.drain();

  const [rejected, waiting] = await store.list();
  assert.deepEqual(sent, ['req-rejected']);
  assert.equal(rejected.state, 'rejected');
  assert.deepEqual(rejected.lastError, {
    code: 'stale_target',
    message: 'message target is stale',
    resultUnknown: false,
  });
  assert.equal(waiting.state, 'pending');
});

test('message outbox does not automatically replay a rejected FIFO head', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() {
      return [...records.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(record => structuredClone(record));
    },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      return {
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' },
      };
    },
  });
  await store.put({
    ...createMessageRequest({
      text: 'rejected head', target: { threadId: 'thr-rejected-head' },
    }, { createId: () => 'req-rejected-head', now: () => 41 }),
    state: 'rejected',
  });
  await outbox.enqueue(createMessageRequest({
    text: 'pending behind rejection', target: { threadId: 'thr-rejected-head' },
  }, { createId: () => 'req-behind-rejection', now: () => 42 }));

  await outbox.drain();

  assert.deepEqual(sent, []);
  assert.deepEqual((await store.list()).map(record => record.state), ['rejected', 'pending']);
});

test('message outbox skips an already queued record while draining later pending input', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() {
      return [...records.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(record => structuredClone(record));
    },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      return {
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' },
      };
    },
  });
  await store.put({
    ...createMessageRequest({
      text: 'already queued', target: { threadId: 'thr-runtime-queue' },
    }, { createId: () => 'req-already-queued', now: () => 43 }),
    state: 'queued',
    receipt: { clientRequestId: 'req-already-queued', state: 'queued' },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'pending after queued', target: { threadId: 'thr-runtime-queue' },
  }, { createId: () => 'req-after-queued', now: () => 44 }));

  await outbox.drain();

  assert.deepEqual(sent, ['req-after-queued']);
  const [queued] = await store.list();
  assert.equal(queued.clientRequestId, 'req-already-queued');
  assert.equal(queued.state, 'queued');
});

test('message outbox drains only requests selected for the active view', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() {
      return [...records.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(record => structuredClone(record));
    },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      return {
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' },
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'active thread', target: { threadId: 'thr-active' },
  }, { createId: () => 'req-active-view', now: () => 47 }));
  await outbox.enqueue(createMessageRequest({
    text: 'background thread', target: { threadId: 'thr-background' },
  }, { createId: () => 'req-background-view', now: () => 48 }));

  await outbox.drain({
    shouldSend: request => request.payload.threadId === 'thr-active',
  });

  assert.deepEqual(sent, ['req-active-view']);
  const [background] = await store.list();
  assert.equal(background.clientRequestId, 'req-background-view');
  assert.equal(background.state, 'pending');
});

test('message outbox marks a successful ack without a receipt as needing reconciliation', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() {
      return [...records.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(record => structuredClone(record));
    },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      return { ok: true };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'unknown first', target: { threadId: 'thr-invalid-receipt' },
  }, { createId: () => 'req-invalid-receipt', now: () => 45 }));
  await outbox.enqueue(createMessageRequest({
    text: 'must remain pending', target: { threadId: 'thr-invalid-receipt' },
  }, { createId: () => 'req-after-invalid-receipt', now: () => 46 }));

  await outbox.drain();
  await outbox.drain();

  const [unknown, waiting] = await store.list();
  assert.deepEqual(sent, ['req-invalid-receipt']);
  assert.equal(unknown.state, 'needs_reconcile');
  assert.deepEqual(unknown.lastError, {
    code: 'invalid_receipt',
    message: 'Message acknowledgement did not contain a matching receipt',
    resultUnknown: true,
  });
  assert.equal(waiting.state, 'pending');
});

test('message outbox quarantines an explicit unknown server result without replaying it', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  let transportCalls = 0;
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport() {
      transportCalls += 1;
      return {
        ok: false,
        retryable: true,
        resultUnknown: true,
        errorCode: 'dispatch_failed',
        error: 'dispatch result is unknown',
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'unknown dispatch', target: { threadId: 'thr-unknown-dispatch' },
  }, { createId: () => 'req-unknown-dispatch', now: () => 49 }));

  await outbox.drain();
  await outbox.drain();

  const [unknown] = await store.list();
  assert.equal(unknown.state, 'needs_reconcile');
  assert.equal(unknown.attempts, 1);
  assert.equal(transportCalls, 1);
  assert.deepEqual(unknown.lastError, {
    code: 'dispatch_failed',
    message: 'dispatch result is unknown',
    resultUnknown: true,
  });
});

test('message outbox automatically retries a definite retryable result', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  let transportCalls = 0;
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      transportCalls += 1;
      if (transportCalls === 1) {
        return {
          ok: false,
          retryable: true,
          resultUnknown: false,
          errorCode: 'runtime_busy',
          error: 'runtime can be retried safely',
        };
      }
      return {
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' },
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'retry known failure', target: { threadId: 'thr-definite-retry' },
  }, { createId: () => 'req-definite-retry', now: () => 49.5 }));

  await outbox.drain();
  const [retryable] = await store.list();
  assert.equal(retryable.state, 'retryable');
  assert.equal(retryable.lastError.resultUnknown, false);

  await outbox.drain();

  assert.equal(transportCalls, 2);
  assert.deepEqual(await store.list(), []);
});

test('message outbox retains a queued receipt until a later durable transition', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      return {
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'queued' },
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'wait in runtime queue', target: { threadId: 'thr-queued' },
  }, { createId: () => 'req-queued', now: () => 50 }));

  await outbox.drain();

  const [queued] = await store.list();
  assert.equal(queued.state, 'queued');
  assert.deepEqual(queued.receipt, {
    clientRequestId: 'req-queued',
    state: 'queued',
  });

  await outbox.acceptReceipt({
    clientRequestId: 'req-queued',
    state: 'submitted',
    turnId: 'turn-after-queue',
  });
  assert.deepEqual(await store.list(), []);
});

test('message outbox records a rejected runtime transition for a queued request', async () => {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      return {
        ok: true,
        receipt: { clientRequestId: payload.clientRequestId, state: 'queued' },
      };
    },
  });
  await outbox.enqueue(createMessageRequest({
    text: 'queued then rejected', target: { threadId: 'thr-rejected-transition' },
  }, { createId: () => 'req-rejected-transition', now: () => 60 }));
  await outbox.drain();

  const accepted = await outbox.acceptReceipt({
    clientRequestId: 'req-rejected-transition',
    state: 'rejected',
    errorCode: 'turn_start_failed',
    error: 'turn/start failed after dequeue',
  });

  const [rejected] = await store.list();
  assert.equal(accepted, true);
  assert.equal(rejected.state, 'rejected');
  assert.deepEqual(rejected.receipt, {
    clientRequestId: 'req-rejected-transition',
    state: 'rejected',
    errorCode: 'turn_start_failed',
    error: 'turn/start failed after dequeue',
  });
  assert.deepEqual(rejected.lastError, {
    code: 'turn_start_failed',
    message: 'turn/start failed after dequeue',
    resultUnknown: false,
  });
});

function createMemoryStore() {
  const records = new Map();
  return {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() {
      return [...records.values()]
        .map(record => structuredClone(record))
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    },
    async delete(clientRequestId) { records.delete(clientRequestId); },
  };
}

test('a rejected head of queue can be discarded instead of wedging every later message', async () => {
  const store = createMemoryStore();
  // 网关明确拒绝过的一条消息，排在同一 thread 的队首。
  await store.put({
    ...createMessageRequest({
      text: 'rejected head', target: { threadId: 'thr-wedge' },
    }, { createId: () => 'req-rejected-head', now: () => 1 }),
    state: 'rejected',
    attempts: 1,
    lastError: { code: 'request_rejected', message: 'runtime refused', resultUnknown: false },
  });
  // 用户之后又发的一条，本该能发出去。
  await store.put(createMessageRequest({
    text: 'blocked tail', target: { threadId: 'thr-wedge' },
  }, { createId: () => 'req-blocked-tail', now: () => 2 }));

  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      return { ok: true, receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' } };
    },
  });

  // 顺序保证要求队首失败时停下，所以队尾此刻发不出去——这本身是对的。
  await outbox.drain();
  assert.deepEqual(sent, []);

  // 但终态记录必须有出口，否则整条队列永远堵死。
  assert.equal(await outbox.discard('req-rejected-head'), true);
  const remaining = await store.list();
  assert.deepEqual(remaining.map(record => record.clientRequestId), ['req-blocked-tail']);

  await outbox.drain();
  assert.deepEqual(sent, ['req-blocked-tail']);
});

test('an attempted request whose provisional target died can be discarded by the user', async () => {
  const store = createMemoryStore();
  // 发过一次就断线的消息：目标是 provisional instance，网关重启后该 instance 已不存在。
  await store.put({
    ...createMessageRequest({
      text: '排查当前项目里的问题和失败，并给出修复', target: { instanceId: 'inst-dead' },
    }, { createId: () => 'req-unreachable', now: () => 1 }),
    state: 'retryable',
    attempts: 1,
    attemptedGatewayEpoch: 'epoch-old',
    lastError: { code: 'runtime_unavailable', message: 'gateway restarted', resultUnknown: false },
  });

  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport() { assert.fail('an unreachable request must never be dispatched automatically'); },
    async reconcileTransport() { return { ok: false, errorCode: 'unknown_request' }; },
  });

  // 三条自动出路都不适用：不能重绑（尝试过）、不能重发（目标不匹配当前视图）、
  // reconcile 的状态白名单也不含 retryable。
  assert.equal(await outbox.rebindUnattempted('req-unreachable', { threadId: 'thr-current' }), null);
  await outbox.drain({ shouldSend: request => request.payload?.instanceId === 'inst-live' });
  const summary = await outbox.reconcile({ shouldReconcile: () => true });
  assert.equal(summary.checked, 0);
  assert.equal((await store.list()).length, 1);

  // 所以用户必须能手动丢弃，否则这条气泡每次连接都重现且无法消除。
  assert.equal(await outbox.discard('req-unreachable'), true);
  assert.deepEqual(await store.list(), []);
});

test('discarding an unknown or already-cleared request is a no-op', async () => {
  const store = createMemoryStore();
  await store.put(createMessageRequest({
    text: 'keep me', target: { threadId: 'thr-keep' },
  }, { createId: () => 'req-keep', now: () => 1 }));
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport() { assert.fail('discard must not dispatch'); },
  });

  assert.equal(await outbox.discard('req-never-existed'), false);
  assert.equal(await outbox.discard(''), false);
  assert.deepEqual((await store.list()).map(record => record.clientRequestId), ['req-keep']);
});

// —— 断线时序 ——
//
// 上面 24 条测试全部用 isConnected: () => true。它们覆盖的是「服务端回了什么」
// （ack、receipt、reconcile 结果），从来没有覆盖「连接本身没了」—— 而这正是这个
// 模块存在的理由。下面几条补的是断线这一维：断开时不发、发到一半断了不丢不乱序、
// 以及页面在 sending 状态下被关掉后重新打开会怎样。

function memoryStore(initial = []) {
  const records = new Map(initial.map(record => [record.clientRequestId, structuredClone(record)]));
  return {
    records,
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
    async delete(id) { records.delete(id); },
  };
}

function requestFor(id, text = id) {
  return createMessageRequest({ text, target: { threadId: 'thr-1' } }, { createId: () => id, now: () => 1 });
}

test('断开时 drain 不发送，队列原样保留等重连', async () => {
  const store = memoryStore([requestFor('req-a'), requestFor('req-b')]);
  let sends = 0;
  const outbox = createMessageOutbox({
    store,
    isConnected: () => false,
    async transport() { sends += 1; return { ok: true, receipt: { state: 'submitted' } }; },
  });

  await outbox.drain();

  assert.equal(sends, 0, '离线时不该往一条死掉的 socket 上发');
  const kept = await store.list();
  assert.deepEqual(kept.map(r => r.clientRequestId), ['req-a', 'req-b']);
  assert.deepEqual(kept.map(r => r.state), ['pending', 'pending'], '状态不该被离线这件事改写');
});

test('断开时 reconcile 不查询也不改状态', async () => {
  const store = memoryStore([{ ...requestFor('req-a'), state: 'needs_reconcile' }]);
  let queries = 0;
  const outbox = createMessageOutbox({
    store,
    isConnected: () => false,
    transport: async () => ({ ok: true }),
    reconcileTransport: async () => { queries += 1; return { ok: true, resolved: true }; },
  });

  const summary = await outbox.reconcile();

  assert.deepEqual(summary, { checked: 0, resolved: 0, unresolved: 0 });
  assert.equal(queries, 0);
  assert.equal((await store.list())[0].state, 'needs_reconcile', '离线的一次 reconcile 不能把状态改掉');
});

test('drain 到一半断线：已发的保持已发，未发的原样留下，顺序不乱', async () => {
  const store = memoryStore([requestFor('req-1'), requestFor('req-2'), requestFor('req-3')]);
  let connected = true;
  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => connected,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      // 第一条发完就断线，模拟服务端还在但网络掉了。
      if (payload.clientRequestId === 'req-1') connected = false;
      return { ok: true, receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' } };
    },
  });

  await outbox.drain();

  assert.deepEqual(sent, ['req-1'], '断线后不该继续往下发');
  const left = await store.list();
  assert.deepEqual(left.map(r => r.clientRequestId), ['req-2', 'req-3'],
    'req-1 已确认提交应当被删除，后两条必须原样留着 —— 丢掉就是丢消息');
  assert.deepEqual(left.map(r => r.state), ['pending', 'pending']);

  // 重连后继续，顺序必须接着来而不是乱序或重发 req-1。
  connected = true;
  await outbox.drain();
  assert.deepEqual(sent, ['req-1', 'req-2', 'req-3'], '重连后按原顺序补发剩下的');
});

test('发送途中断线的那一条进入待核对，并挡住它后面的消息', async () => {
  const store = memoryStore([requestFor('req-1'), requestFor('req-2')]);
  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      if (payload.clientRequestId === 'req-1') {
        // emitWithAck 在断线时抛的就是这个形状：可重试，但结果未知。
        const error = new Error('Socket disconnected before acknowledgement');
        error.code = 'socket_disconnected';
        error.retryable = true;
        error.resultUnknown = true;
        throw error;
      }
      return { ok: true, receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' } };
    },
  });

  await outbox.drain();

  assert.deepEqual(sent, ['req-1'], 'FIFO：结果未知的头部必须挡住后面的，否则会乱序');
  const records = await store.list();
  assert.equal(records[0].state, 'needs_reconcile',
    '断线时消息可能已经送达，只是 ack 没回来 —— 不能当成没发过');
  assert.equal(records[0].lastError.resultUnknown, true);
  assert.equal(records[1].state, 'pending', '后面那条不该被连累改状态');
});

test('页面在 sending 状态下被关掉，重新打开后按同一个 id 重发而不是丢弃', async () => {
  // IndexedDB 里留下的就是这个形状：attempts 已加一、state 停在 sending。
  const stranded = { ...requestFor('req-stranded'), state: 'sending', attempts: 1 };
  const store = memoryStore([stranded]);
  const sent = [];
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      return { ok: true, receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' } };
    },
  });

  await outbox.drain();

  assert.deepEqual(sent, ['req-stranded'],
    '停在 sending 的消息必须被重发 —— 否则用户以为发出去了，实际上永远躺在本地');
  assert.equal(sent.length, 1);
  assert.equal((await store.list()).length, 0, '服务端按同一个 clientRequestId 去重，确认后本地要清掉');
});

test('reconcile 不处理 sending，交给 drain 靠 clientRequestId 幂等重发', async () => {
  const store = memoryStore([{ ...requestFor('req-stranded'), state: 'sending', attempts: 1 }]);
  let queries = 0;
  const outbox = createMessageOutbox({
    store,
    isConnected: () => true,
    transport: async () => ({ ok: true, receipt: { clientRequestId: 'req-stranded', state: 'submitted' } }),
    reconcileTransport: async () => { queries += 1; return { ok: true, resolved: true }; },
  });

  const summary = await outbox.reconcile();

  assert.equal(queries, 0, 'sending 不走核对');
  assert.equal(summary.checked, 0,
    '这是有意的分工：核对只管 needs_reconcile 和 queued，sending 由 drain 重发，'
    + '服务端的回执账本按 clientRequestId 去重，重发不会变成发两次');
});

// 同 test/message-request.test.mjs 里那条的姐妹用例：outbox 是发消息的实际入口，
// 它自己也有一个默认 createId。修 message-request 而漏掉这里，等于把三处调用点里的
// 缺陷从两处减到一处 —— 而这轮反复出现的正是「防御只加在部分调用点上」这个形态。
test('outbox 在没有 randomUUID 的环境里照样能发出消息', async () => {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', {
    value: { getRandomValues: original.getRandomValues.bind(original) },
    configurable: true,
    writable: true,
  });
  try {
    assert.equal(typeof globalThis.crypto.randomUUID, 'undefined', '前置：本测试要模拟没有 randomUUID');

    let stored = [];
    const sent = [];
    const outbox = createMessageOutbox({
      store: {
        async put(record) { stored = [structuredClone(record)]; },
        async list() { return structuredClone(stored); },
      },
      isConnected: () => true,
      async transport(payload) {
        sent.push(payload.clientRequestId);
        return { ok: true, receipt: { state: 'submitted' } };
      },
    });

    await outbox.enqueue(createMessageRequest({ text: '明文远程接入下发一条', target: { threadId: 'thr-x' } }));
    await outbox.drain();
    assert.equal(sent.length, 1, '消息没被送出去 —— 这正是非 secure context 下的静默失败');
    assert.ok(sent[0] && sent[0].length >= 16, `clientRequestId 太短：${sent[0]}`);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true, writable: true });
  }
});

// ---- 变异补漏：批 3（DELIVER-03/04/05/07） ----

function outboxStore({ withDelete = true } = {}) {
  const records = new Map();
  const store = {
    async put(record) { records.set(record.clientRequestId, structuredClone(record)); },
    async list() { return [...records.values()].map(record => structuredClone(record)); },
  };
  if (withDelete) store.delete = async id => { records.delete(id); };
  return { store, records };
}

function pendingRequest(overrides = {}) {
  return {
    ...createMessageRequest({ text: 'hello', target: { threadId: 'thr' } },
      { createId: () => 'req-1', now: () => 1 }),
    ...overrides,
  };
}

// 失败的分类决定这条消息接下来会不会被重发，三个方向的后果完全不同：
//   retryable       → 下次 drain 会再发一次
//   rejected        → 不再自动重发，等用户处理
//   needs_reconcile → 结果未知，只能先去核对，绝不能直接重发
// 分错任何一个方向，要么消息静默丢失，要么同一条消息被执行两次。
test('drain 对失败的分类决定这条消息还会不会被重发', async () => {
  const cases = [
    ['明确可重试', { retryable: true }, 'retryable'],
    ['明确不可重试', { retryable: false }, 'rejected'],
    ['没说可不可重试 → 保守地当成不可重试', {}, 'rejected'],
    ['结果未知优先于可重试', { resultUnknown: true, retryable: true }, 'needs_reconcile'],
  ];

  for (const [label, shape, expected] of cases) {
    const { store, records } = outboxStore();
    const outbox = createMessageOutbox({
      store,
      transport: async () => { throw Object.assign(new Error('boom'), shape); },
    });
    await outbox.enqueue(pendingRequest());
    await outbox.drain();
    assert.equal(records.get('req-1').state, expected, label);
  }
});

// transport 抛出的不一定是 Error：Promise reject 一个 null、一个字符串都可能。
// 兜底文案要在那时候顶上，否则用户看到的失败原因是字面量 "null"。
test('transport 抛出非 Error 时也给得出可读的失败原因', async () => {
  const { store, records } = outboxStore();
  const outbox = createMessageOutbox({ store, transport: async () => { throw null; } });
  await outbox.enqueue(pendingRequest());
  await outbox.drain();

  const record = records.get('req-1');
  assert.equal(record.lastError.code, 'transport_error');
  assert.equal(record.lastError.message, 'transport error', '不能把字面量 "null" 当成失败原因给用户看');
});

// steered 与 submitted 一样表示「消息已经进了 runtime」，都必须清出 outbox。
// 漏掉 steered 的后果是刷新一次页面就重发一遍——而 steered 恰恰是插话到运行中 turn
// 的那条路径，重发的副作用直接落在正在跑的任务上。
test('steered 回执与 submitted 一样把请求清出 outbox', async () => {
  for (const state of ['submitted', 'steered']) {
    const { store, records } = outboxStore();
    const outbox = createMessageOutbox({
      store,
      transport: async payload => ({ ok: true, receipt: { clientRequestId: payload.clientRequestId, state } }),
    });
    await outbox.enqueue(pendingRequest());
    await outbox.drain();
    assert.equal(records.size, 0, `${state} 回执之后请求必须离开 outbox，否则刷新一次就会重发`);
  }
});

// store 没有 delete 能力时（降级到内存实现的场景）不能直接调它。
test('store 不支持 delete 时，已完成的请求留在原地而不是让 drain 抛异常', async () => {
  const { store, records } = outboxStore({ withDelete: false });
  const outbox = createMessageOutbox({
    store,
    transport: async payload => ({
      ok: true, receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' },
    }),
  });
  await outbox.enqueue(pendingRequest());
  await outbox.drain();
  assert.equal(records.size, 1, '删不掉就留着，不能因为缺 delete 就炸掉整个 drain');
});

// DELIVER-05：从未尝试过的记录可以保留原 id 重绑，但目标必须是**能落地的**。
// 空串、数字这种"看着有值"的目标绑上去，消息会发往一个不存在的会话而没人发现。
test('rebind 要求一个能落地的目标：空串、非字符串、两者皆无都不行', async () => {
  const seed = async () => {
    const { store, records } = outboxStore();
    const outbox = createMessageOutbox({ store, transport: async () => ({ ok: true }) });
    await outbox.enqueue(pendingRequest({ payload: undefined, state: 'pending' }));
    return { outbox, records };
  };

  for (const bad of [undefined, {}, { threadId: '' }, { instanceId: '' }, { threadId: 123 }]) {
    const { outbox } = await seed();
    await assert.rejects(
      () => outbox.rebindUnattempted('req-1', bad),
      /exact target/,
      `目标 ${JSON.stringify(bad)} 落不了地，必须拒绝而不是绑上去`,
    );
  }

  // threadId 与 instanceId 有其一就够——不是两个都要。要求两个都有会让
  // 「还没拿到 threadId 的 provisional 会话」永远重绑不了。
  for (const good of [{ threadId: 'thr-new' }, { instanceId: 'inst-new' }]) {
    const { outbox } = await seed();
    const rebound = await outbox.rebindUnattempted('req-1', good);
    assert.ok(rebound, `目标 ${JSON.stringify(good)} 应当足以重绑`);
    assert.equal(rebound.clientRequestId, 'req-1',
      '从未尝试过，所以保留原 id；换新 id 反而会在服务端看起来像第二条消息');
  }
});

// reconcile 是**只读核对**，它的三条出路各自意味着不同的下一步。
test('reconcile 的三条出路各自可辨：核对上、明确被拒、仍然未知', async () => {
  const seed = async reconcileTransport => {
    const { store, records } = outboxStore();
    const outbox = createMessageOutbox({
      store, transport: async () => ({ ok: true }), reconcileTransport,
    });
    await store.put(pendingRequest({ state: 'needs_reconcile' }));
    return { outbox, records };
  };

  {
    const { outbox, records } = await seed(async () => ({
      ok: true, resolved: true, receipt: { clientRequestId: 'req-1', state: 'submitted' },
    }));
    assert.deepEqual(await outbox.reconcile(), { checked: 1, resolved: 1, unresolved: 0 });
    assert.equal(records.size, 0, '核对到「已提交」就该清出 outbox');
  }

  {
    const { outbox, records } = await seed(async () => ({
      ok: true, resolved: true, gatewayEpoch: 'ep-2',
      outcome: { ok: false, errorCode: 'thread_closed', error: '会话已关闭', resultUnknown: false, retryable: false },
    }));
    assert.deepEqual(await outbox.reconcile(), { checked: 1, resolved: 1, unresolved: 0 });
    const record = records.get('req-1');
    assert.equal(record.state, 'rejected');
    assert.equal(record.lastError.code, 'thread_closed', '服务端给了具体原因就要透出去，不能换成通用文案');
    assert.equal(record.lastError.message, '会话已关闭');
    assert.equal(record.lastError.resultUnknown, false, '明确被拒就是明确的，不能标成结果未知');
    assert.equal(record.reconciledGatewayEpoch, 'ep-2');
  }

  // ⚠ 反直觉：「服务端说这次失败了、可以重试」**不等于**「消息没被执行过」。
  // 判成 resolved 会让它进入自动重发，而重发的副作用直接落在真实工作区上。
  {
    const { outbox, records } = await seed(async () => ({
      ok: true, resolved: true,
      outcome: { ok: false, errorCode: 'queue_full', error: '队列满', retryable: true },
    }));
    assert.deepEqual(await outbox.reconcile(), { checked: 1, resolved: 0, unresolved: 1 });
    assert.equal(records.get('req-1').state, 'needs_reconcile');
    assert.equal(records.get('req-1').lastReconcileError.resultUnknown, true);
  }

  {
    const { outbox, records } = await seed(async () => { throw null; });
    assert.deepEqual(await outbox.reconcile(), { checked: 1, resolved: 0, unresolved: 1 });
    const record = records.get('req-1');
    assert.equal(record.lastReconcileError.code, 'reconcile_transport_error');
    assert.equal(record.lastReconcileError.message, 'Message reconciliation failed',
      '核对通道自己坏了要说清是通道坏了，不能笼统地说「结果仍然未知」');
  }
});

test('断线时 reconcile 也不动手，不只是 drain', async () => {
  const { store, records } = outboxStore();
  let sends = 0;
  let reconciles = 0;
  const outbox = createMessageOutbox({
    store,
    isConnected: () => false,
    transport: async () => { sends += 1; return { ok: true }; },
    reconcileTransport: async () => { reconciles += 1; return { ok: true }; },
  });
  await store.put(pendingRequest({ state: 'needs_reconcile' }));

  assert.deepEqual(await outbox.reconcile(), { checked: 0, resolved: 0, unresolved: 0 });
  assert.equal(reconciles, 0, '断线时不该发核对请求');
  await outbox.drain();
  assert.equal(sends, 0, '断线时不该发消息');
  assert.equal(records.get('req-1').state, 'needs_reconcile', '记录原样保留');
});

// 不传 isConnected 时默认「已连接」。默认成 false 的话，任何没显式接线的调用方
// 都会得到一个永远不发消息的 outbox——而且不报错。
test('不传 isConnected 时默认按已连接处理', async () => {
  const { store, records } = outboxStore();
  const outbox = createMessageOutbox({
    store,
    transport: async payload => ({
      ok: true, receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' },
    }),
  });
  await outbox.enqueue(pendingRequest());
  await outbox.drain();
  assert.equal(records.size, 0, '默认应当真的会发出去');
});

test('缺少 store 能力或 transport 时当场报错，而不是等到第一次发送才炸', () => {
  const transport = async () => ({ ok: true });
  assert.throws(() => createMessageOutbox({ transport }), /requires a store/);
  assert.throws(() => createMessageOutbox({ store: {}, transport }), /requires a store/);
  assert.throws(() => createMessageOutbox({ store: { put() {} }, transport }), /requires a store/,
    '只有 put 没有 list 也不行——两个能力都要，缺一个就在运行时才炸');
  assert.throws(() => createMessageOutbox({ store: { list() {} }, transport }), /requires a store/);
  assert.throws(() => createMessageOutbox({ store: { put() {}, list() {} } }), /requires a transport/);
});

// 这几个返回值是调用方判断「这次操作到底做没做」的唯一依据。
test('enqueue / acceptReceipt / retryAfterConfirmation / discard 的返回值是契约', async () => {
  const { store, records } = outboxStore();
  const outbox = createMessageOutbox({ store, transport: async () => ({ ok: true }) });
  const record = pendingRequest();

  assert.equal(await outbox.enqueue(record), record, 'enqueue 回传入队的那条记录');

  assert.equal(await outbox.acceptReceipt(null), false, '没有回执就没有可接受的东西');
  assert.equal(await outbox.acceptReceipt({ clientRequestId: 'nobody', state: 'submitted' }), false,
    '认不出的 clientRequestId 不能算接受成功');
  assert.equal(await outbox.acceptReceipt({ clientRequestId: 'req-1', state: '???' }), false,
    '认不出的状态不能算接受成功');
  assert.equal(await outbox.acceptReceipt({ clientRequestId: 'req-1', state: 'queued' }), true);
  assert.equal(records.get('req-1').state, 'queued');

  // 只有 needs_reconcile 的记录才谈得上「用户确认后重试」。对别的状态动手会造成重复发送。
  assert.equal(await outbox.retryAfterConfirmation('req-1'), null,
    'queued 的记录还在正常流程里，不该被换成新请求');
  assert.equal(await outbox.retryAfterConfirmation('nobody'), null);

  assert.equal(await outbox.discard(''), false);
  assert.equal(await outbox.discard(123), false);
  assert.equal(await outbox.discard('nobody'), false, '不存在的记录丢弃不了，要如实返回 false');
  assert.equal(await outbox.discard('req-1'), true);
  assert.equal(records.size, 0);
});

// drain 期间再次调用 drain 会把选项排队合并。合并规则的方向很关键：
// 任一方没有筛选条件 = 「全发」，合并结果必须也是全发，而不是取交集。
// 取交集的话，只有一方想发的消息在那一轮里被静默跳过——它不会报错，只是没发出去。
async function gatedOutbox(ids) {
  const { store, records } = outboxStore();
  let releaseList;
  let markGateReached;
  const listGate = new Promise(resolve => { releaseList = resolve; });
  // 排队必须发生在 while 循环体**已经启动之后**：循环进去第一件事就是把
  // queuedDrainOptions 清空，在那之前排的队会被擦掉（这条测试第一版就是这么写错的）。
  const gateReached = new Promise(resolve => { markGateReached = resolve; });
  let listCalls = 0;
  const sent = [];

  const gatedStore = {
    ...store,
    async list() {
      listCalls += 1;
      if (listCalls === 1) {
        markGateReached();
        await listGate;
      }
      return store.list();
    },
  };
  const outbox = createMessageOutbox({
    store: gatedStore,
    async transport(payload) {
      sent.push(payload.clientRequestId);
      return { ok: true, receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' } };
    },
  });
  for (const id of ids) {
    await outbox.enqueue({
      ...createMessageRequest({ text: id, target: { threadId: 'thr' } }, { createId: () => id, now: () => 1 }),
    });
  }
  return { outbox, records, sent, releaseList, gateReached };
}

const only = id => ({ shouldSend: request => request.clientRequestId === id });

test('drain 排队合并：任一方没有筛选条件就等于全发', async () => {
  const { outbox, sent, releaseList, gateReached } = await gatedOutbox(['req-a', 'req-b']);

  const first = outbox.drain({ shouldSend: () => false }); // 第一轮谁也不发，判断落在第二轮
  await gateReached;
  outbox.drain(only('req-a'));
  outbox.drain({});                                        // 没有条件 = 全发
  releaseList();
  await first;

  assert.deepEqual(sent.sort(), ['req-a', 'req-b'],
    '合并后有一方是「全发」，结果就该是全发；取交集会让 req-b 在这一轮被静默跳过');
});

test('drain 排队合并：两方都有筛选条件时取并集，不是交集也不是全发', async () => {
  const { outbox, sent, releaseList, gateReached } = await gatedOutbox(['req-a', 'req-b', 'req-c']);

  const first = outbox.drain({ shouldSend: () => false });
  await gateReached;
  outbox.drain(only('req-a'));
  outbox.drain(only('req-b'));
  releaseList();
  await first;

  assert.deepEqual(sent.sort(), ['req-a', 'req-b'],
    '并集：两方各自想发的都要发；req-c 谁也没要，退化成「全发」同样是错的');
});

// 已经在跑的 drain 必须把**正在进行的那个 promise** 交回去。返回 null 的话，
// 调用方的 `await outbox.drain()` 会立刻返回，而队列其实还在发——它会以为发完了。
test('drain 期间再次调用返回的是正在进行的那个 promise，不是空值', async () => {
  const { outbox, sent, releaseList } = await gatedOutbox(['req-a']);

  const first = outbox.drain();
  const second = outbox.drain();
  assert.ok(second && typeof second.then === 'function', '必须交回一个可以 await 的东西');

  releaseList();
  await second;
  assert.deepEqual(sent, ['req-a'], 'await 第二次调用之后，队列必须真的已经发完');
  await first;
});

// 没配核对通道时 reconcile 必须原地返回，而不是进循环去调一个不是函数的东西——
// 那个调用会被 try/catch 吞掉，变成「核对失败，结果仍然未知」，把一条本来干净的记录
// 标上一个假的失败原因。
test('没配 reconcileTransport 时 reconcile 原地返回，不伪造一条核对失败', async () => {
  const { store, records } = outboxStore();
  const outbox = createMessageOutbox({ store, transport: async () => ({ ok: true }) });
  await store.put(pendingRequest({ state: 'needs_reconcile' }));

  assert.deepEqual(await outbox.reconcile(), { checked: 0, resolved: 0, unresolved: 0 });
  assert.equal(records.get('req-1').lastReconcileError, undefined,
    '没核对过就不该留下核对失败的痕迹');
});

// DELIVER-05：用户确认重试时可以指定一个新目标（原会话已失效的情况）。
// 忽略它、沿用旧 payload 里的目标，消息就会再次发往那个已经不存在的会话。
test('retryAfterConfirmation 用调用方给的目标，而不是旧记录里的那个', async () => {
  const { store, records } = outboxStore();
  const outbox = createMessageOutbox({ store, transport: async () => ({ ok: true }) });
  await store.put(pendingRequest({ state: 'needs_reconcile' }));

  const replacement = await outbox.retryAfterConfirmation('req-1', {
    target: { threadId: 'thr-new' },
    confirmedAt: 999,
  });

  assert.ok(replacement, '需要核对的记录应当可以在用户确认后重试');
  assert.equal(replacement.payload.threadId, 'thr-new', '必须用调用方指定的新目标');
  assert.equal(replacement.retryOfClientRequestId, 'req-1', '新请求要指回它替代的那一条');
  assert.notEqual(replacement.clientRequestId, 'req-1', '已尝试过，必须换新 id——旧 id 不得复活');
  assert.equal(records.has('req-1'), false, '旧记录要被替换掉');
});
