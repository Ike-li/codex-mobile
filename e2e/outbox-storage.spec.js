import { test, expect } from '@playwright/test';

test('IndexedDB outbox records survive reload in stable creation order', async ({ page }) => {
  const dbName = `ccm-outbox-test-${Date.now()}`;
  await page.goto('/');

  const beforeReload = await page.evaluate(async name => {
    const { createIndexedDbMessageStore } = await import('/js/outbox/indexeddb-outbox.js');
    const store = createIndexedDbMessageStore({ dbName: name });
    await store.put({ clientRequestId: 'req-later', createdAt: 20, state: 'pending', payload: {} });
    await store.put({ clientRequestId: 'req-earlier', createdAt: 10, state: 'pending', payload: {} });
    const ids = (await store.list()).map(record => record.clientRequestId);
    store.close();
    return ids;
  }, dbName);
  expect(beforeReload).toEqual(['req-earlier', 'req-later']);

  await page.reload();
  const afterReload = await page.evaluate(async name => {
    const { createIndexedDbMessageStore } = await import('/js/outbox/indexeddb-outbox.js');
    const store = createIndexedDbMessageStore({ dbName: name });
    const ids = (await store.list()).map(record => record.clientRequestId);
    await store.clear();
    store.close();
    return ids;
  }, dbName);

  expect(afterReload).toEqual(['req-earlier', 'req-later']);
});

test('IndexedDB outbox quarantines an interrupted sending record instead of replaying it', async ({ page }) => {
  const dbName = `ccm-outbox-recovery-${Date.now()}`;
  await page.goto('/');
  await page.evaluate(async name => {
    const { createIndexedDbMessageStore } = await import('/js/outbox/indexeddb-outbox.js');
    const store = createIndexedDbMessageStore({ dbName: name });
    await store.put({
      clientRequestId: 'req-interrupted',
      createdAt: 10,
      state: 'sending',
      attempts: 2,
      payload: { clientRequestId: 'req-interrupted', text: 'same payload', threadId: 'thr-recovery' },
    });
    store.close();
  }, dbName);

  await page.reload();
  const recovered = await page.evaluate(async name => {
    const { createIndexedDbMessageStore } = await import('/js/outbox/indexeddb-outbox.js');
    const { createMessageOutbox } = await import('/js/outbox/message-outbox.js');
    const store = createIndexedDbMessageStore({ dbName: name });
    const count = await store.recoverInterrupted();
    let transportCalls = 0;
    const outbox = createMessageOutbox({
      store,
      isConnected: () => true,
      async transport(payload) {
        transportCalls += 1;
        return {
          ok: true,
          receipt: { clientRequestId: payload.clientRequestId, state: 'submitted' },
        };
      },
    });
    await outbox.drain();
    const [record] = await store.list();
    await store.clear();
    store.close();
    return { count, record, transportCalls };
  }, dbName);

  expect(recovered.count).toBe(1);
  expect(recovered.record.state).toBe('needs_reconcile');
  expect(recovered.record.attempts).toBe(2);
  expect(recovered.transportCalls).toBe(0);
  expect(recovered.record.lastError).toEqual({
    code: 'client_restart',
    message: 'The previous send attempt was interrupted',
    resultUnknown: true,
  });
  expect(recovered.record.payload).toEqual({
    clientRequestId: 'req-interrupted',
    text: 'same payload',
    threadId: 'thr-recovery',
  });
});

test('IndexedDB outbox marks an unverified queued receipt for reconciliation after restart', async ({ page }) => {
  const dbName = `ccm-outbox-queued-recovery-${Date.now()}`;
  await page.goto('/');
  await page.evaluate(async name => {
    const { createIndexedDbMessageStore } = await import('/js/outbox/indexeddb-outbox.js');
    const store = createIndexedDbMessageStore({ dbName: name });
    await store.put({
      clientRequestId: 'req-queued-before-restart',
      createdAt: 11,
      state: 'queued',
      attempts: 1,
      receipt: {
        clientRequestId: 'req-queued-before-restart',
        state: 'queued',
      },
      payload: {
        clientRequestId: 'req-queued-before-restart',
        text: 'queued in gateway memory',
        threadId: 'thr-queued-recovery',
      },
    });
    store.close();
  }, dbName);

  await page.reload();
  const recovered = await page.evaluate(async name => {
    const { createIndexedDbMessageStore } = await import('/js/outbox/indexeddb-outbox.js');
    const { createMessageOutbox } = await import('/js/outbox/message-outbox.js');
    const store = createIndexedDbMessageStore({ dbName: name });
    const count = await store.recoverInterrupted();
    let transportCalls = 0;
    const outbox = createMessageOutbox({
      store,
      isConnected: () => true,
      async transport() {
        transportCalls += 1;
        return { ok: false };
      },
    });
    await outbox.drain();
    const [record] = await store.list();
    await store.clear();
    store.close();
    return { count, record, transportCalls };
  }, dbName);

  expect(recovered.count).toBe(1);
  expect(recovered.transportCalls).toBe(0);
  expect(recovered.record.state).toBe('needs_reconcile');
  expect(recovered.record.attempts).toBe(1);
  expect(recovered.record.receipt).toEqual({
    clientRequestId: 'req-queued-before-restart',
    state: 'queued',
  });
  expect(recovered.record.lastError).toEqual({
    code: 'queued_state_unverified',
    message: 'The previous queued receipt could not be verified after restart',
    resultUnknown: true,
  });
});
