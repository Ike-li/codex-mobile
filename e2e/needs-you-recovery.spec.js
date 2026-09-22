import { test, expect } from '@playwright/test';

test('a fresh mobile page recovers and resolves a pending cross-thread approval', async ({ page, browser }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await page.locator('#msg-input').fill('approve needs-you recovery');
  await page.locator('#send-btn').click();
  await expect(page.locator('.tool-card[data-card="decision"]').last()).toBeVisible({ timeout: 10000 });

  const freshContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const freshPage = await freshContext.newPage();
  try {
    await freshPage.goto('http://localhost:3232/');
    await expect(freshPage.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    const needsPanel = freshPage.locator('#needs-you-panel');
    await expect(needsPanel).toBeVisible({ timeout: 10000 });
    await expect(needsPanel).toContainText('approve needs-you recovery');
    await needsPanel.locator('[data-need-action="open"]').click();

    const recoveredCard = freshPage.locator('.tool-card[data-card="decision"]').last();
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
  await expect(page.locator('.tool-card[data-card="decision"]').last()).toBeVisible({ timeout: 10000 });

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
  await expect(page.locator('.tool-card[data-card="decision"]').last()).toBeVisible({ timeout: 10000 });

  // 横幅只在审批卡看不见时出现，所以量布局之前得先把卡片推出视野——这条守的是
  // 「横幅出现时不拉满整窗」，不是「横幅总在」。
  await page.locator('.tool-card[data-card="decision"]').last()
    .evaluate(card => { card.style.marginBottom = '3000px'; });
  await page.locator('#messages').evaluate(el => { el.scrollTop = el.scrollHeight; });
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

  await page.locator('.tool-card[data-card="decision"]').last().locator('.approve-btn[data-d="accept"]').click();
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
});

// 「需要你」横幅的唯一职责是把**看不见的**待办拉到眼前。卡片就在视野里时再挂一条
// 横幅，是同一件事在一屏内说两遍，还占掉首屏六分之一的高度。
test('审批卡在视野里时横幅收起，滚出视野就回来', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await page.locator('#msg-input').fill('approve visible card');
  await page.locator('#send-btn').click();
  await expect(page.locator('.tool-card[data-card="decision"]').last()).toBeVisible({ timeout: 10000 });

  await expect(page.locator('#needs-you-panel'), '卡片就在眼前，横幅不该再说一遍').toBeHidden();

  // 把卡片推出视野，等价于长会话里滚上去
  await page.locator('.tool-card[data-card="decision"]').last()
    .evaluate(card => { card.style.marginBottom = '3000px'; });
  await page.locator('#messages').evaluate(el => { el.scrollTop = el.scrollHeight; });
  // 正对照：不验这一侧的话，「横幅永不出现」也能让上一条断言通过。
  await expect(page.locator('#needs-you-panel'), '看不见了就必须把它拉回眼前').toBeVisible({ timeout: 5000 });
});

test('空落地页与横幅读同一份待审批，数字不会打架', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await page.locator('#msg-input').fill('approve landing count');
  await page.locator('#send-btn').click();
  await expect(page.locator('.tool-card[data-card="decision"]').last()).toBeVisible({ timeout: 10000 });

  // 新建会话回到空落地页：审批卡随会话离开 DOM，横幅必须重新出现
  await page.locator('#header-new').click();
  const landing = page.locator('#empty-actions');
  await expect(landing).toContainText('等你批准', { timeout: 10000 });
  await expect(page.locator('#needs-you-panel'), '卡片已不在 DOM，横幅要回来').toBeVisible({ timeout: 5000 });

  // 两处读的是同一份 needsYou，只刷一处就会在同屏给出两个数字。
  const landingCount = (await landing.innerText()).match(/(\d+)\s*项等你批准/)?.[1];
  const bannerCount = (await page.locator('.needs-you-heading').innerText()).match(/(\d+)/)?.[1];
  expect(landingCount, '落地页读不出待审批数').toBeTruthy();
  expect(landingCount, `落地页说 ${landingCount} 项，横幅说 ${bannerCount} 项`).toBe(bannerCount);
});
