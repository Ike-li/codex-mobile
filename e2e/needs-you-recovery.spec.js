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

    // fresh page 落在空会话上，待审批的入口是落地页那颗按钮——横幅在有可见入口时收起。
    const landingEntry = freshPage.locator('[data-empty-action="approvals"]');
    await expect(landingEntry).toBeVisible({ timeout: 10000 });
    await expect(freshPage.locator('#needs-you-panel'), '落地页已经有入口了').toBeHidden();
    await landingEntry.click();

    const recoveredCard = freshPage.locator('.tool-card[data-card="decision"]').last();
    await expect(recoveredCard).toBeVisible();
    await recoveredCard.locator('.approve-btn[data-d="accept"]').click();
    await expect(recoveredCard).toContainText('已批准');
    await expect(freshPage.locator('#needs-you-panel')).toBeHidden();
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
    // 横幅在落地页上收起，目标改挂在落地页那颗按钮的 data 属性上。
    const landingEntry = freshPage.locator('[data-empty-action="approvals"]');
    await expect(landingEntry).toBeVisible({ timeout: 10000 });
    const needId = await landingEntry.getAttribute('data-need-id');
    const threadId = await landingEntry.getAttribute('data-thread-id');
    expect(needId, '入口必须带上它要打开的那一条').toBeTruthy();

    // 按钮上不该把内部 threadId 写给用户看 —— 它对人没有任何意义。
    await expect(landingEntry).not.toContainText(threadId);

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

// 空落地页已经把「N 项等你批准」摆在正中间，横幅再挂一条就是同一件事说两遍——
// 和「审批卡在视野里」是同一条判据，只是可见入口换成了落地页那颗按钮。
test('空落地页把待审批摆在正中间时，横幅不再重复一遍', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await page.locator('#msg-input').fill('approve landing count');
  await page.locator('#send-btn').click();
  await expect(page.locator('.tool-card[data-card="decision"]').last()).toBeVisible({ timeout: 10000 });

  await page.locator('#header-new').click();
  const landing = page.locator('#empty-actions');
  await expect(landing).toContainText('等你批准', { timeout: 10000 });
  await expect(page.locator('#needs-you-panel'), '落地页已经把它摆在正中间了').toBeHidden();

  // 落地页的数字来自同一份 needsYou，不能因为横幅收起就不再跟着刷。
  const landingCount = (await landing.innerText()).match(/(\d+)\s*项等你批准/)?.[1];
  expect(Number(landingCount), '落地页读不出待审批数').toBeGreaterThan(0);
});

// 正对照：落地页入口一旦不在（回到会话视图且卡片看不见），横幅必须重新承担提醒。
test('离开落地页且审批卡看不见时，横幅重新出现', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await page.locator('#msg-input').fill('approve back to thread');
  await page.locator('#send-btn').click();
  const card = page.locator('.tool-card[data-card="decision"]').last();
  await expect(card).toBeVisible({ timeout: 10000 });
  // 断言收敛到「当前这一条」：mock server 的 needs 跨用例累积，横幅里可能还挂着
  // 别的用例留下的待办，按整条横幅的显隐来断言会被那些串扰。
  await expect(page.locator('#needs-you-panel'), '卡片就在眼前').not.toContainText('approve back to thread');

  await card.evaluate(el => { el.style.marginBottom = '3000px'; });
  await page.locator('#messages').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('#needs-you-panel'), '没有任何可见入口时横幅要把它拉回来')
    .toContainText('approve back to thread', { timeout: 5000 });
});
