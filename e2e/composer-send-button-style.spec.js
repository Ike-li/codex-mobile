// e2e/composer-send-button-style.spec.js —— 发送/停止按钮的主操作色守护。
// coverage: docs/TESTING.md
//
// 主操作是墨色方钮：浅色界面深底浅标、深色界面浅底深标。发送态和停止态同一颗
// 按钮、只换图标，底色不变。不用饱和品牌蓝——那是聊天产品的主按钮，不是这台
// 工作台的。
import { test, expect } from '@playwright/test';
import { contrastRatio, parseRgb } from './lib/contrast.js';

async function btnStyle(page) {
  return page.locator('#send-btn').evaluate(el => {
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      bg: cs.backgroundColor,
      color: cs.color,
      radius: parseFloat(cs.borderTopLeftRadius),
      width: rect.width,
    };
  });
}

function chroma(value) {
  const [r, g, b] = parseRgb(value);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function expectInkToolButton(style, where) {
  expect(
    chroma(style.bg),
    `${where}：底色不是近中性的墨（${style.bg}）`,
  ).toBeLessThan(50);
  expect(
    contrastRatio(style.color, style.bg),
    `${where}：图标压在底上不够清楚（icon ${style.color} / bg ${style.bg}）`,
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    style.radius,
    `${where}：还是正圆按钮（radius ${style.radius} / width ${style.width}）`,
  ).toBeLessThan(style.width * 0.4);
}

test.describe('发送按钮的主操作色', () => {
  test('有文字时是墨色方钮白箭头，turn 进行中原地换成同色的停止钮', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('SLOW_TURN');
    await expect(page.locator('#send-btn')).toBeVisible();
    await expect(page.locator('#send-btn')).toHaveAttribute('data-mode', 'send');
    const sendStyle = await btnStyle(page);
    expectInkToolButton(sendStyle, '发送态');

    await page.locator('#send-btn').click();
    await expect(page.locator('#send-btn'))
      .toHaveAttribute('data-mode', 'stop', { timeout: 5000 });
    const stopStyle = await btnStyle(page);
    expectInkToolButton(stopStyle, '停止态');

    expect(stopStyle.bg, '停止态和发送态底色不一致').toBe(sendStyle.bg);

    await page.locator('#send-btn').click();
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  });

  test('深色模式下是浅墨底深色图标，同样不是正圆', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('深色下也要看得出是主操作');
    await expect(page.locator('#send-btn')).toBeVisible();
    expectInkToolButton(await btnStyle(page), '深色发送态');
  });
});
