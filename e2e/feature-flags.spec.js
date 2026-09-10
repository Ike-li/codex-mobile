import { test, expect } from '@playwright/test';

// 宿主配置不再是特性开关——解锁机制（源码常量口令、至少三条绕行路径）拆除后，
// 它是直达但逐动作确认的普通操作，所以入口常驻可见。这条守的是它不要再被藏回开关后面。
//
// 2026-09-10：Labs/P3 面板整个删除后，这里不再有任何被开关隐藏的入口。
test('host config stays reachable instead of hiding behind a feature flag', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await page.locator('#menu-btn').click();
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  await expect(page.locator('#native-host-config-btn')).toBeVisible();
});
