import { test, expect } from '@playwright/test';

test('offline message survives page close and drains once after reconnect', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await context.setOffline(true);
  await expect(page.locator('#state-label')).toHaveText('offline', { timeout: 10000 });
  await page.locator('#msg-input').fill('persist across page close');
  await page.locator('#send-btn').click();
  await expect(
    page.locator('.msg.user.offline').filter({ hasText: 'persist across page close' }),
  ).toHaveCount(1);

  const storedBeforeClose = await page.evaluate(async () => {
    const { createIndexedDbMessageStore } = await import('/js/outbox/indexeddb-outbox.js');
    const store = createIndexedDbMessageStore();
    const records = await store.list();
    store.close();
    return records;
  });
  expect(storedBeforeClose).toHaveLength(1);
  expect(storedBeforeClose[0].payload.text).toBe('persist across page close');

  await page.close();
  await context.setOffline(false);
  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect(reopened.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
  await expect(
    reopened.locator('.msg.user').filter({ hasText: 'persist across page close' }),
  ).toHaveCount(1, { timeout: 10000 });
  await expect(
    reopened.locator('.msg.codex').filter({ hasText: 'Mock response to: persist across page close' }),
  ).toHaveCount(1, { timeout: 10000 });

  await expect.poll(async () => reopened.evaluate(async () => {
    const { createIndexedDbMessageStore } = await import('/js/outbox/indexeddb-outbox.js');
    const store = createIndexedDbMessageStore();
    const records = await store.list();
    store.close();
    return records.length;
  })).toBe(0);
});

test('recovered outbox binds its view before app-server streams ahead of the ack', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await context.setOffline(true);
  await expect(page.locator('#state-label')).toHaveText('offline', { timeout: 10000 });
  await page.locator('#msg-input').fill('PRE_ACK_STREAM persisted request');
  await page.locator('#send-btn').click();
  await expect(page.locator('.msg.user.offline').filter({ hasText: 'PRE_ACK_STREAM persisted request' }))
    .toHaveCount(1);

  await page.close();
  await context.setOffline(false);
  const reopened = await context.newPage();
  await reopened.goto('/');

  await expect(reopened.locator('.msg.codex').filter({ hasText: 'PRE_ACK_STREAM_OK' }))
    .toHaveCount(1, { timeout: 10000 });
});

test('a never-attempted provisional request rebinds after its instance disappears', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
  await page.evaluate(async () => {
    const { createIndexedDbMessageStore } = await import('/js/outbox/indexeddb-outbox.js');
    const store = createIndexedDbMessageStore();
    await store.put({
      clientRequestId: 'req-e2e-unattempted-orphan',
      createdAt: Date.now(),
      state: 'pending',
      payload: {
        clientRequestId: 'req-e2e-unattempted-orphan',
        text: 'recover never attempted orphan',
        instanceId: 'inst-no-longer-exists',
      },
    });
    store.close();
  });

  await page.reload();

  await expect(page.locator('.msg.user').filter({ hasText: 'recover never attempted orphan' }))
    .toHaveCount(1, { timeout: 10000 });
  await expect(page.locator('.msg.codex').filter({ hasText: 'Mock response to: recover never attempted orphan' }))
    .toHaveCount(1, { timeout: 10000 });
  await expect.poll(async () => page.evaluate(async () => {
    const { createIndexedDbMessageStore } = await import('/js/outbox/indexeddb-outbox.js');
    const store = createIndexedDbMessageStore();
    const records = await store.list();
    store.close();
    return records.length;
  })).toBe(0);
});

test('an attempted provisional orphan waits for fresh-id confirmation before sending', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
  await page.evaluate(async () => {
    const { createIndexedDbMessageStore } = await import('/js/outbox/indexeddb-outbox.js');
    const store = createIndexedDbMessageStore();
    await store.put({
      clientRequestId: 'req-e2e-attempted-orphan',
      createdAt: Date.now(),
      state: 'needs_reconcile',
      attempts: 1,
      attemptedGatewayEpoch: 'gateway-that-restarted',
      payload: {
        clientRequestId: 'req-e2e-attempted-orphan',
        text: 'confirm attempted orphan retry',
        instanceId: 'inst-no-longer-exists',
      },
    });
    store.close();
  });

  await page.reload();

  const bubble = page.locator('.msg.user.offline').filter({ hasText: 'confirm attempted orphan retry' });
  await expect(bubble).toContainText('原会话目标已失效', { timeout: 10000 });
  await expect(page.locator('.msg.codex').filter({ hasText: 'Mock response to: confirm attempted orphan retry' }))
    .toHaveCount(0);

  await bubble.locator('.unknown-retry-btn').click();
  await expect(page.locator('#confirm-modal')).toBeVisible();
  await page.locator('#confirm-ok').click();

  await expect(page.locator('.msg.codex').filter({ hasText: 'Mock response to: confirm attempted orphan retry' }))
    .toHaveCount(1, { timeout: 10000 });
  const finalIds = await page.evaluate(async () => {
    const { createIndexedDbMessageStore } = await import('/js/outbox/indexeddb-outbox.js');
    const store = createIndexedDbMessageStore();
    const records = await store.list();
    store.close();
    return records.map(record => record.clientRequestId);
  });
  expect(finalIds).not.toContain('req-e2e-attempted-orphan');
});
