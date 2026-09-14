// e2e/composer-send-button-style.spec.js —— 发送/停止按钮的主操作色守护。
// coverage: docs/TESTING.md
//
// 2026-09-14：桌面端那颗按钮是蓝底白图标——输入框有文字时是白箭头，turn 进行中
// 原地换成白方块，位置和底色都不变。这边原先是白底深色箭头加 1px 浅边框，在白
// 输入框上读不出「这是主操作」。色值从用户给的两张桌面端截图里取（用 canvas 统计
// 蓝色像素，两张的众数都是 #3a83f7），不是估的。
//
// 判据取相对关系而不是钉死 rgb 字面量：同 docs/TESTING.md 里 feature-flags 那条
// 教训——钉死一套主题的色值会让另一套恒红，而「主操作一眼认得出」两套都成立。
import { test, expect } from '@playwright/test';

function rgb(value) {
  const [r, g, b] = value.match(/[\d.]+/g).map(Number);
  return { r, g, b };
}

async function btnStyle(page) {
  return page.locator('#send-btn').evaluate(el => {
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color };
  });
}

/** 蓝底白图标。透明背景会在第一条上红：rgba(0,0,0,0) 解析出来 b - r = 0。 */
function expectBlueWithWhiteIcon(style, where) {
  const bg = rgb(style.bg);
  expect(bg.b - bg.r, `${where}：按钮底色不是蓝的（${style.bg}）`).toBeGreaterThan(40);
  const fg = rgb(style.color);
  expect(Math.min(fg.r, fg.g, fg.b), `${where}：图标不是白的（${style.color}）`)
    .toBeGreaterThan(240);
}

test.describe('发送按钮的主操作色', () => {
  test('有文字时是蓝底白箭头，turn 进行中原地换成同色的停止钮', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('SLOW_TURN');
    await expect(page.locator('#send-btn')).toBeVisible();
    await expect(page.locator('#send-btn')).toHaveAttribute('data-mode', 'send');
    const sendStyle = await btnStyle(page);
    expectBlueWithWhiteIcon(sendStyle, '发送态');

    await page.locator('#send-btn').click();
    await expect(page.locator('#send-btn'))
      .toHaveAttribute('data-mode', 'stop', { timeout: 5000 });
    const stopStyle = await btnStyle(page);
    expectBlueWithWhiteIcon(stopStyle, '停止态');

    // 这条才是「和桌面端对齐」的本体：同一颗按钮原地换图标，底色不变。两态各自
    // 是蓝还不够——一个亮蓝一个深蓝会让人以为换了个控件。
    expect(stopStyle.bg, '停止态和发送态底色不一致').toBe(sendStyle.bg);

    // 收尾：中断并等回 idle，别把未决状态留给共享 mock server 上的后续用例。
    await page.locator('#send-btn').click();
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  });

  test('深色模式下同样是蓝底白图标', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('深色下也要看得出是主操作');
    await expect(page.locator('#send-btn')).toBeVisible();
    expectBlueWithWhiteIcon(await btnStyle(page), '深色发送态');
  });
});
