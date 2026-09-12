import { test, expect } from '@playwright/test';

test('a fresh mobile page recovers and resolves a pending cross-thread approval', async ({ page, browser }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await page.locator('#msg-input').fill('approve needs-you recovery');
  await page.locator('#send-btn').click();
  await expect(page.locator('.tool-card').filter({ hasText: '需要审批' }).last()).toBeVisible({ timeout: 10000 });

  const freshContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const freshPage = await freshContext.newPage();
  try {
    await freshPage.goto('http://localhost:3232/');
    await expect(freshPage.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    const needsPanel = freshPage.locator('#needs-you-panel');
    await expect(needsPanel).toBeVisible({ timeout: 10000 });
    await expect(needsPanel).toContainText('approve needs-you recovery');
    await needsPanel.locator('[data-need-action="open"]').click();

    const recoveredCard = freshPage.locator('.tool-card').filter({ hasText: '需要审批' }).last();
    await expect(recoveredCard).toBeVisible();
    await recoveredCard.locator('.approve-btn[data-d="accept"]').click();
    await expect(recoveredCard).toContainText('已批准');
    await expect(needsPanel).toBeHidden();
  } finally {
    await freshContext.close();
  }
});

test('a needs-you deep link opens the exact pending approval', async ({ page, browser }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
  await page.locator('#msg-input').fill('approve needs-you deep link');
  await page.locator('#send-btn').click();
  await expect(page.locator('.tool-card').filter({ hasText: '需要审批' }).last()).toBeVisible({ timeout: 10000 });

  const freshContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const freshPage = await freshContext.newPage();
  try {
    await freshPage.goto('http://localhost:3232/');
    const row = freshPage.locator('#needs-you-panel [data-need-id]').filter({ hasText: 'approve needs-you deep link' });
    await expect(row).toBeVisible({ timeout: 10000 });
    const needId = await row.getAttribute('data-need-id');
    // 从 data 属性读，不从显示文本读：那一行给用户看的是会话名，不是内部 id。
    const threadId = await row.getAttribute('data-thread-id');

    // 面板上不该出现内部 threadId —— 它对用户没有任何意义，而「需要你」正是用户
    // 最需要快速判断「是哪个会话在等我」的地方。
    await expect(row.locator('.needs-you-thread')).not.toHaveText(threadId);

    await freshPage.goto(`http://localhost:3232/?thread=${encodeURIComponent(threadId)}&need=${encodeURIComponent(needId)}`);
    const recoveredCard = freshPage.locator('.tool-card').filter({ hasText: 'approve needs-you deep link' }).last();
    await expect(recoveredCard).toBeVisible({ timeout: 10000 });
    await recoveredCard.locator('.deny-btn').click();
    await expect(recoveredCard).toContainText('已拒绝');
  } finally {
    await freshContext.close();
  }
});

test('needs-you 条在宽屏上收进阅读栏', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await page.locator('#msg-input').fill('approve needs-you column');
  await page.locator('#send-btn').click();
  const needsPanel = page.locator('#needs-you-panel');
  await expect(needsPanel).toBeVisible({ timeout: 10000 });

  const panelBox = await needsPanel.boundingBox();
  const columnBox = await page.locator('#input-area').boundingBox();
  expect(panelBox, 'needs-you 条应有布局盒').toBeTruthy();
  expect(columnBox, '输入区应有布局盒').toBeTruthy();
  expect(panelBox.width, '宽屏上不应拉满整窗').toBeLessThanOrEqual(720);
  expect(
    Math.abs(panelBox.x - columnBox.x),
    `needs-you 条应与输入区左对齐(Δx=${Math.round(Math.abs(panelBox.x - columnBox.x))})`,
  ).toBeLessThanOrEqual(8);

  await page.locator('.tool-card').filter({ hasText: '需要审批' }).last().locator('.approve-btn[data-d="accept"]').click();
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
});
