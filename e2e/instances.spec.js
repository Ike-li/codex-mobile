// coverage: docs/TESTING.md
// seed: e2e/seed.spec.ts

import { test, expect } from '@playwright/test';

const forbiddenRuntimeErrors = [
  /TypeError/i,
  /ServiceWorker.*scope/i,
  /The path of the provided scope/i,
  /scope.*not under the max scope allowed/i,
  /Content Security Policy/i,
  /Refused to load.*Content Security Policy/i,
  /Refused to connect.*Content Security Policy/i,
  /Refused to apply.*Content Security Policy/i,
];

function collectRuntimeErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', error => {
    errors.push(error.message);
  });
  return errors;
}

function expectNoForbiddenRuntimeErrors(errors) {
  const output = errors.join('\n');
  for (const pattern of forbiddenRuntimeErrors) {
    expect(output, `unexpected browser runtime error matching ${pattern}`).not.toMatch(pattern);
  }
}

async function sendMessage(page, text) {
  await page.locator('#msg-input').fill(text);
  await page.locator('#send-btn').click();
}

async function expectCurrentExchange(page, text, userIndex, codexIndex) {
  await expect(page.locator('.msg.user').filter({ hasText: text }).nth(userIndex)).toBeVisible();
  await expect(page.locator('.msg.codex').filter({ hasText: `Mock response to: ${text}` }).nth(codexIndex)).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
}

test.describe('Multi Instance Tabs', () => {
  test('Multi Instance Tabs', async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);
    const firstMessage = `first multi instance message ${Date.now()}`;
    const secondMessage = `second multi instance message ${Date.now()}`;

    // 1. Open `/`, wait until `#state-label` is not `offline`.
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    // 2. Send the first normal message and wait for the corresponding mock response.
    const firstUserMessages = page.locator('.msg.user').filter({ hasText: firstMessage });
    const firstCodexMessages = page.locator('.msg.codex').filter({ hasText: `Mock response to: ${firstMessage}` });
    const firstUserIndex = await firstUserMessages.count();
    const firstCodexIndex = await firstCodexMessages.count();
    await sendMessage(page, firstMessage);
    await expectCurrentExchange(page, firstMessage, firstUserIndex, firstCodexIndex);

    // 3. Open the drawer and create a new session on the current workspace row.
    // Main chrome must not show instance tabs.
    await page.locator('#menu-btn').click();
    await expect(page.locator('#drawer-title')).toHaveText('工作区与会话');
    const newSessionButton = page.locator('#drawer-projects .dir-new').first();
    await expect(newSessionButton).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#btn-general-settings')).toBeVisible();
    await expect(page.locator('#drawer-projects')).toBeVisible();
    await expect(page.locator('#drawer-projects .drawer-project-item').first()).toBeVisible();
    await expect(page.locator('#drawer-projects .dir-subtree.expanded .session-item').first()).toBeVisible();
    await newSessionButton.click();
    await expect(page.locator('#instance-tabs')).toHaveCount(0);
    await expect(page.locator('#thread-title')).toHaveText('新会话');

    // 4. Send the second normal message and wait for the corresponding mock response.
    const secondUserMessages = page.locator('.msg.user').filter({ hasText: secondMessage });
    const secondCodexMessages = page.locator('.msg.codex').filter({ hasText: `Mock response to: ${secondMessage}` });
    const secondUserIndex = await secondUserMessages.count();
    const secondCodexIndex = await secondCodexMessages.count();
    await sendMessage(page, secondMessage);
    await expectCurrentExchange(page, secondMessage, secondUserIndex, secondCodexIndex);
    await expect(page.locator('.msg.user').filter({ hasText: firstMessage })).toHaveCount(0);
    await expect(page.locator('#instance-tabs')).toHaveCount(0);
    expectNoForbiddenRuntimeErrors(runtimeErrors);
  });
});
