// e2e/approval-card-style.spec.js —— 审批卡按钮的视觉层级守护。
// coverage: docs/TESTING.md
import { test, expect } from '@playwright/test';

// 刺眼的实心大红 var(--error) = #df1c1c。拒绝按钮改为次要样式后不应再是这个背景。
const HARSH_RED = 'rgb(223, 28, 28)';

test.describe('审批卡按钮视觉层级', () => {
  test('拒绝按钮为克制的次要样式,批准按钮为实心主操作色', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    await page.locator('#msg-input').fill('approve this command');
    await page.locator('#send-btn').click();

    const card = page.locator('.tool-card').filter({ hasText: '需要审批' }).last();
    await expect(card).toBeVisible({ timeout: 10000 });

    const denyBg = await card.locator('.deny-btn').evaluate(
      el => el.ownerDocument.defaultView.getComputedStyle(el).backgroundColor,
    );
    expect(denyBg, '拒绝按钮不应是刺眼的实心大红').not.toBe(HARSH_RED);

    // 批准是主操作:实心的中性 accent（2026-09-14 去绿前是 OpenAI 绿）。
    // 判据取「等于 --accent token 的实际渲染值」而不是钉死一个 rgb 字面量——
    // 见 docs/TESTING.md 里 feature-flags 那条教训：--accent 深浅两套主题反相
    // （#0d0d0d / #f2f2f2），钉死一套会让另一套恒红，而「批准是主操作色」两套都成立。
    const { approveBg, accentBg } = await card.locator('.approve-btn').first().evaluate(el => {
      const doc = el.ownerDocument;
      const win = doc.defaultView;
      const probe = doc.createElement('div');
      probe.style.background = 'var(--accent)';
      doc.body.append(probe);
      const accent = win.getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { approveBg: win.getComputedStyle(el).backgroundColor, accentBg: accent };
    });
    expect(approveBg, '批准按钮应是实心的主操作色 --accent').toBe(accentBg);
    expect(approveBg, '批准按钮和拒绝按钮的底色应拉开层级').not.toBe(denyBg);

    const cardBox = await card.boundingBox();
    const messagesBox = await page.locator('#messages').boundingBox();
    expect(cardBox, '审批卡应有布局盒').toBeTruthy();
    expect(messagesBox, '消息区应有布局盒').toBeTruthy();
    expect(
      cardBox.width,
      `审批卡应拉满阅读栏(实测 ${Math.round(cardBox.width)} / ${Math.round(messagesBox.width)})`,
    ).toBeGreaterThan(messagesBox.width * 0.8);

    // 清理:响应审批并等待回到 idle,避免遗留未决状态污染共享 mock server 上的后续用例。
    await card.locator('.approve-btn[data-d="accept"]').click();
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  });
});
