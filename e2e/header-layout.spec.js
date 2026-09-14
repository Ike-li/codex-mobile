// e2e/header-layout.spec.js —— 顶部导航紧凑度 + Native 控制栏折叠收纳守护。
// coverage: docs/TESTING.md
import { test, expect } from '@playwright/test';

const MAX_HEADER_HEIGHT = 72; // 单行：会话钮 + 工作区胶囊 + home/+

async function layoutBox(page, selector) {
  const box = await page.locator(selector).boundingBox();
  expect(box, `${selector} should have a layout box`).toBeTruthy();
  return box;
}

async function connect(page) {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
}

test.describe('顶部导航紧凑度', () => {
  test('标题栏压薄且不折行', async ({ page }) => {
    await connect(page);
    await expect(page.locator('#header')).toBeVisible();

    const header = await layoutBox(page, '#header');
    expect(
      header.height,
      `标题栏应 ≤ ${MAX_HEADER_HEIGHT}px(实测 ${Math.round(header.height)}px)`,
    ).toBeLessThanOrEqual(MAX_HEADER_HEIGHT);

    await expect(page.locator('#header-context')).toBeVisible();
    await expect(page.locator('#header-project'), '顶栏应显示项目名而不是路径和下拉框').toBeVisible();
    await expect(page.locator('#header-project')).not.toHaveText('');
    await expect(page.locator('#header-home')).toBeVisible();
    await expect(page.locator('#header-new')).toBeVisible();
    await expect(page.locator('#menu-btn')).toBeVisible();
    // 连接状态不再挂在会话钮上：在线看延迟条（本 test 末尾两行），掉线看 #conn-banner。
    // 去绿后那颗点变成纯黑实心，在移动端读起来是「未读角标」而不是状态灯。
    await expect(page.locator('#status-dot'), '连接状态点已移除，别加回来').toHaveCount(0);
    await expect(page.locator('#thread-title')).toHaveText('新会话');
    await expect(page.locator('#workdir-container'), '工作区切换只留在抽屉').toBeHidden();
    await expect(page.locator('#header #composer-defaults')).toHaveCount(0);
    await expect(page.locator('#input-area #composer-defaults')).toBeVisible();
    await expect(page.locator('#conn-rtt')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#conn-rtt')).toContainText(/延迟/);
  });

  test('工作区胶囊打开 sheet，首页清空当前会话视图', async ({ page }) => {
    await connect(page);

    await page.locator('#header-context').click();
    await expect(page.locator('#workspace-modal')).toBeVisible();
    await page.locator('#workspace-close').click();
    await expect(page.locator('#workspace-modal')).toBeHidden();

    await page.locator('#msg-input').fill('HEADER_HOME_CLEAR');
    await page.locator('#send-btn').click();
    await expect(page.locator('.msg.user').filter({ hasText: 'HEADER_HOME_CLEAR' })).toBeVisible({
      timeout: 10000,
    });

    await page.locator('#header-home').click();
    await expect(page.locator('#empty-state')).toBeVisible();
    await expect(page.locator('.msg.user').filter({ hasText: 'HEADER_HOME_CLEAR' })).toHaveCount(0);
  });

  test('工具控制栏收进抽屉,顶部不再有常驻工具行', async ({ page }) => {
    await connect(page);

    // 顶部不再有工具入口行:控制栏已整体移进左侧抽屉。
    await expect(page.locator('#native-controls-toggle'), '顶部工具入口应已移除').toHaveCount(0);
    await expect(page.locator('#native-controls'), '默认(抽屉关闭)控制栏不在视口内').not.toBeInViewport();

    await page.locator('#menu-btn').click();
    await expect(page.locator('#drawer')).toHaveClass(/open/);
    // 工具栏移进抽屉是为了让顶栏变清爽，不是为了让这些功能消失：Files / 诊断 / 设备
    // 都只有这一个入口，整块隐藏等于建了却点不到。
    await expect(page.locator('#drawer-tools'), '抽屉里应当能看到工具面板').toBeVisible();
    await expect(page.locator('#native-thread-refresh'), '工具按钮对用户可见').toBeVisible();
    await expect(page.locator('#drawer-title')).toHaveText('工作区与会话');
    await expect(page.locator('#drawer-close')).toBeVisible();
    await expect(page.locator('#new-session-btn')).toHaveCount(0);
    await expect(page.locator('#drawer-fab-new')).toHaveCount(0);
    await expect(page.locator('#drawer-project')).toHaveCount(0);
    await expect(page.locator('#drawer-projects')).toBeInViewport();
    await expect.poll(async () => page.locator('#drawer-body').evaluate(el => el.scrollTop)).toBe(0);

    await page.locator('#drawer-close').click();
    await expect(page.locator('#drawer')).not.toHaveClass(/open/);
  });

  test('连接状态条在宽屏上收进阅读栏', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await connect(page);

    await page.locator('#conn-banner').evaluate(el => {
      el.hidden = false;
      el.dataset.tone = 'warn';
      const text = el.querySelector('#conn-banner-text');
      if (text) text.textContent = '连接断开，自动重连中…';
    });

    const banner = page.locator('#conn-banner');
    await expect(banner).toBeVisible();
    const bannerBox = await banner.boundingBox();
    const columnBox = await page.locator('#input-area').boundingBox();
    expect(bannerBox, '连接条应有布局盒').toBeTruthy();
    expect(columnBox, '输入区应有布局盒').toBeTruthy();
    expect(bannerBox.width, '宽屏上不应拉满整窗').toBeLessThanOrEqual(720);
    expect(
      Math.abs(bannerBox.x - columnBox.x),
      `连接条应与输入区左对齐(Δx=${Math.round(Math.abs(bannerBox.x - columnBox.x))})`,
    ).toBeLessThanOrEqual(8);
  });
});
