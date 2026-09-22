// coverage: docs/TESTING.md
// seed: e2e/seed.spec.ts

import { test, expect } from '@playwright/test';

const forbiddenRuntimeErrors = [
  /TypeError/i,
  /ServiceWorker.*scope/i,
  /The path of the provided scope/i,
  /scope.*not under the max scope allowed/i,
  /Content Security Policy/i,
  /Refused to load/i,
  /Refused to connect/i,
  /Refused to apply/i,
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

async function expectNativePanelOpen(page, label, expectedPattern = /.+/) {
  const panel = page.locator('#native-panel');
  await expect(panel, `${label} panel should be visible`).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#msg-input'), 'chat input should remain available').toBeVisible();
  await expect.poll(
    async () => (await panel.innerText()).replace(/\s+/g, ' ').trim(),
    { message: `${label} panel should show expected data or recoverable state`, timeout: 10000 },
  ).toMatch(expectedPattern);
  const text = (await panel.innerText()).replace(/\s+/g, ' ').trim();
  return text;
}

async function clickNativeControl(page, selector) {
  const panel = page.locator('#native-panel');
  if (await panel.isVisible().catch(() => false)) {
    await panel.locator('[data-close-native]').click();
    await expect(panel).toBeHidden();
  }
  // 工具按钮已收进左侧抽屉;点击某按钮会关闭抽屉,故每次点击前按需重新打开。
  const drawer = page.locator('#drawer');
  const isOpen = await drawer.evaluate(el => el.classList.contains('open')).catch(() => false);
  if (!isOpen) {
    await page.locator('#menu-btn').click();
    await expect(drawer).toHaveClass(/open/);
  }
  // 账号 / 主机状态那批入口又往下收了一层,进了抽屉底部的「设置与状态」sheet。
  // 判据是「抽屉里看不见就往下一层找」,不在这里硬编码哪几个按钮搬了家——
  // 名单以后还会变,这条规则不会。
  const target = page.locator(selector);
  if (!(await target.isVisible())) {
    await page.locator('#btn-general-settings').click();
    await expect(page.locator('#settings-sheet')).toBeVisible();
  }
  // 用真实 click 而不是 dispatchEvent：后者直接把事件派发到元素上，绕过可见性检查，
  // 于是按钮即便对用户完全不可见，这些断言照样是绿的——工具面板整块被 hidden 的那段
  // 时间里就是如此。判据必须是「用户点得到」，不是「元素存在」。
  await target.click();
}

test.describe('Native Controls Browser Panels', () => {
  test('工具入口在抽屉与设置两处都对用户可见', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await page.locator('#menu-btn').click();
    await expect(page.locator('#drawer')).toHaveClass(/open/);
    await expect(page.locator('#drawer-tools')).toHaveCount(0);
    await expect(page.locator('#native-thread-refresh')).toHaveCount(0);

    // 名单从 DOM 派生，不写死。此前这里硬编码了三个按钮，于是另外八个工具入口
    // 一个都没有可达性覆盖，新加一个工具也不会自动被守住 —— 而「面板在、里面点不到」
    // 正是这个文件开头那段注释记录的那次事故。
    //
    // 入口拆成两处后（抽屉留会话/工作区工具，账号与主机进设置 sheet），这里跟着
    // 扫两处：只扫抽屉会让搬走的 7 个入口重新失去覆盖，正是上面那段要防的事。
    async function countReachable(scope, label) {
      const buttons = page.locator(`${scope} button`);
      const count = await buttons.count();
      expect(count, `${label}里一个按钮都没有，说明渲染没跑或选择器失配`).toBeGreaterThan(0);

      let reachable = 0;
      for (let i = 0; i < count; i += 1) {
        const button = buttons.nth(i);
        const id = (await button.getAttribute('id')) || `第 ${i + 1} 个`;
        // 条件渲染的入口按 [hidden] 属性跳过，不按 id 白名单——#push-subscribe-btn
        // 要浏览器支持推送且 VAPID 三项配齐才出现，mock 下恒为 hidden。按属性判断
        // 的话，将来再加条件入口不用回来改这里。
        if (await button.evaluate(el => el.hidden)) continue;
        await expect(button, `${label}的 ${id} 存在但用户点不到`).toBeVisible();
        const box = await button.boundingBox();
        expect(box?.height ?? 0, `${label}的 ${id} 高度为 0，视觉上不存在`).toBeGreaterThan(0);
        reachable += 1;
      }
      return reachable;
    }

    await page.locator('#btn-general-settings').click();
    await expect(page.locator('#settings-sheet')).toBeVisible();
    const inSettings = await countReachable('#settings-sheet-body', '设置与状态');

    expect(
      inSettings,
      `设置与状态可达入口 ${inSettings} 个，账号/MCP/诊断/设备/Skills/Import/宿主配置应都在`,
    ).toBeGreaterThanOrEqual(7);
  });

  test('Native Controls Browser Panels', async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);

    // 1. Open / and wait until #state-label is not offline.
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    await page.locator('#header-context').click();
    await expect(page.locator('#workspace-modal'), '文件入口是工作区 sheet').toBeVisible();
    await page.locator('#workspace-close').click();

    await page.locator('[data-testid="composer-defaults"]').click();
    await expect(page.locator('#session-settings')).toBeVisible();
    await expect(page.locator('#model-list .popover-item').first()).toBeVisible();
    await page.locator('#session-settings-close').click();

    for (const [selector, label, pattern] of [
      // 「无法读取」曾经列在这里，于是账号面板恒为错误态这件事在 e2e 上是绿的。
      // 钉住 mock 的邮箱：只有 account/read + usage + rateLimits 三条都回来才写得出它。
      ['#native-account-btn', '账号', /mock@example\.com/i],
      ['#native-mcp-btn', 'MCP', /github/i],
      ['#native-skills-btn', '技能', /技能|没有已启用|无法读取/i],
      ['#native-import-btn', '导入配置', /导入|没有可导入/i],
    ]) {
      await clickNativeControl(page, selector);
      await expectNativePanelOpen(page, label, pattern);

      if (selector === '#native-mcp-btn') {
        await expect(
          page.locator('#messages'),
          'MCP 面板的协议错误不得写进对话',
        ).not.toContainText(/unknown variant|MCP read failed/i);
      }
    }

    expectNoForbiddenRuntimeErrors(runtimeErrors);
  });

  test('空会话打开 MCP 面板时不挡住「这轮改什么？」', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await expect(page.locator('#empty-heading')).toBeVisible();

    await clickNativeControl(page, '#native-mcp-btn');
    await expectNativePanelOpen(page, 'MCP', /github/i);

    await expect(page.locator('#native-panel .sheet-card'), 'MCP 应作为 sheet 浮层，不挤对话栏').toBeVisible();
    await expect(page.locator('#native-panel')).toContainText('computer-use');

    await page.locator('#native-panel [data-close-native]').click();
    await expect(page.locator('#native-panel')).toBeHidden();
    await expect(page.locator('#empty-heading')).toBeVisible();
  });
});

