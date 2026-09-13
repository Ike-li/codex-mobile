import { test, expect } from '@playwright/test';

// 宿主配置不再是特性开关——解锁机制（源码常量口令、至少三条绕行路径）拆除后，
// 它是直达但逐动作确认的普通操作，所以入口常驻可见。这条守的是它不要再被藏回开关后面。
//
// 2026-09-10：Labs/P3 面板整个删除后，这里不再有任何被开关隐藏的入口。
//
// 2026-09-13：入口从抽屉收进了「设置与状态」sheet。守的东西没变——这条防的是
// 「藏回特性开关后面」（需要口令或隐藏手势才能解锁），不是「多点一层」。分组归位
// 是信息架构，解锁机制才是这条要挡的东西：路径上每一步都是常驻可见的普通按钮。
test('host config stays reachable instead of hiding behind a feature flag', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await page.locator('#menu-btn').click();
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  await expect(page.locator('#btn-general-settings'), '设置入口本身必须常驻可见').toBeVisible();
  await page.locator('#btn-general-settings').click();
  await expect(page.locator('#settings-sheet')).toBeVisible();
  await expect(page.locator('#native-host-config-btn')).toBeVisible();

  // 可达还不够，它得**看起来**和旁边的普通入口不一样。
  //
  // 收编进设置 sheet 时实测踩到：.native-danger 定义在 .settings-action-btn 前面，
  // 两者特异性相同(0,1,0)，后定义的通用类把 color / border-color 一起覆盖掉了——
  // 「宿主配置」和「Account」在截图里长得一模一样，而 CSS 不会为此报任何错。
  // 判据取「和同组普通按钮的颜色不同」而不是某个具体色值：深浅两套主题下色值不同，
  // 钉死一个会让另一套恒红，而「危险的要能一眼认出来」在两套下都成立。
  const colors = await page.evaluate(() => {
    const win = globalThis;
    const pick = id => {
      const cs = win.getComputedStyle(win.document.getElementById(id));
      return { color: cs.color, border: cs.borderTopColor };
    };
    return { danger: pick('native-host-config-btn'), plain: pick('native-account-btn') };
  });
  expect(
    colors.danger.color !== colors.plain.color || colors.danger.border !== colors.plain.border,
    `危险入口和普通入口的配色一样（文字 ${colors.danger.color}、边框 ${colors.danger.border}），`
    + '误触它的代价和点开 Account 不是一回事',
  ).toBe(true);
});

// 「和旁边不一样」还不等于「读得清」——红字踩到深色底上照样可能糊。
//
// 深色实测踩到过：.native-danger 取的是基色 var(--error)（#df1c1c），而 :root 的深色块里
// 专门备了文字档 --error-text: #ff8888，注释白纸黑字写着「基色 #df1c1c 只有 3.22:1」。
// token 一直在，只是这处没用对，实测「宿主配置」在深色下 3.51:1，低于 AA 正文的 4.5。
// 两种配色都要跑：浅色下两个 token 同值，只测浅色的话这个缺陷永远不会暴露。
test('危险入口的文字在浅色与深色下都过 AA', async ({ page }) => {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await page.locator('#menu-btn').click();
    await page.locator('#btn-general-settings').click();
    await expect(page.locator('#settings-sheet')).toBeVisible();

    const measured = await page.evaluate(() => {
      const win = globalThis;
      const channel = v => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const luminance = rgb => {
        const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map(Number).map(channel);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const el = win.document.getElementById('native-host-config-btn');
      const fg = win.getComputedStyle(el).color;
      // 按钮自身背景是透明的，落在 sheet 的底色上。
      const bg = win.getComputedStyle(win.document.getElementById('settings-sheet')).backgroundColor;
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      return { fg, bg, ratio: (hi + 0.05) / (lo + 0.05) };
    });

    expect(
      measured.ratio,
      `${scheme} 下危险入口的文字 ${measured.fg} 压在 ${measured.bg} 上只有 `
      + `${measured.ratio.toFixed(2)}:1，低于 WCAG AA 正文的 4.5:1`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});
