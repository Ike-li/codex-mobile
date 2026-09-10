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
  // 工具按钮已收进左侧抽屉;点击某按钮会关闭抽屉,故每次点击前按需重新打开。
  const drawer = page.locator('#drawer');
  const isOpen = await drawer.evaluate(el => el.classList.contains('open')).catch(() => false);
  if (!isOpen) {
    await page.locator('#menu-btn').click();
    await expect(drawer).toHaveClass(/open/);
  }
  // 用真实 click 而不是 dispatchEvent：后者直接把事件派发到元素上，绕过可见性检查，
  // 于是按钮即便对用户完全不可见，这些断言照样是绿的——工具面板整块被 hidden 的那段
  // 时间里就是如此。判据必须是「用户点得到」，不是「元素存在」。
  await page.locator(selector).click();
}

test.describe('Native Controls Browser Panels', () => {
  test('工具面板在抽屉里对用户可见', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await page.locator('#menu-btn').click();
    await expect(page.locator('#drawer')).toHaveClass(/open/);
    // 只断言「HTML 里有这个 id」挡不住整块被 hidden：判据必须是用户真的看得见。
    await expect(page.locator('#drawer-tools')).toBeVisible();

    // 名单从 DOM 派生，不写死。此前这里硬编码了三个按钮，于是另外八个工具入口
    // （compact / devices / host-config / import / mcp / models / rollback / skills）
    // 一个都没有可达性覆盖，新加一个工具也不会自动被守住 —— 而「面板在、里面点不到」
    // 正是这个文件开头那段注释记录的那次事故。
    const buttons = page.locator('#drawer-tools button');
    const count = await buttons.count();
    expect(count, '工具面板里应当有按钮；一个都没有说明渲染没跑或选择器失配').toBeGreaterThan(5);

    let reachable = 0;
    for (let i = 0; i < count; i += 1) {
      const button = buttons.nth(i);
      const id = (await button.getAttribute('id')) || `第 ${i + 1} 个`;
      // 2026-09-10 Labs 删除后这里不再有 hidden 按钮，因此不再跳过任何一个：
      // 工具面板里的每个按钮都必须可见。将来若真要藏一个，这条会红——那是对的。
      await expect(button, `${id} 存在但用户点不到`).toBeVisible();
      const box = await button.boundingBox();
      expect(box?.height ?? 0, `${id} 高度为 0，视觉上不存在`).toBeGreaterThan(0);
      reachable += 1;
    }
    expect(reachable, '所有未被特性开关隐藏的工具入口都应当可达').toBeGreaterThan(5);
  });

  test('Native Controls Browser Panels', async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);

    // 1. Open / and wait until #state-label is not offline.
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    // 2. Click #native-thread-refresh.(工具按钮已移入抽屉,clickNativeControl 会按需打开抽屉)
    await clickNativeControl(page, '#native-thread-refresh');
    await expectNativePanelOpen(page, 'Threads', /Native Threads|No native threads|Thread list failed/i);

    // 3. Click #native-models-btn, #native-files-btn, #native-account-btn, #native-mcp-btn, #native-skills-btn, and #native-import-btn.
    for (const [selector, label, pattern] of [
      ['#native-models-btn', 'Models', /Models|No models|Model list failed/i],
      ['#native-files-btn', 'Files', /Files|Empty directory|Read directory failed/i],
      ['#native-account-btn', 'Account', /Account|Account read failed/i],
      ['#native-mcp-btn', 'MCP', /MCP|No MCP servers|MCP read failed/i],
      ['#native-skills-btn', 'Skills', /Skills|No skills|Skills read failed/i],
      ['#native-import-btn', 'Import', /Import|No importable config|Detect failed/i],
    ]) {
      await clickNativeControl(page, selector);
      const panelText = await expectNativePanelOpen(page, label, pattern);

      if (selector === '#native-files-btn') {
        // 4. For the Files panel, click a visible directory/file row or assert an empty/recoverable state if the mock app-server returns no entries.
        const fileActions = page.locator('#native-panel [data-dir], #native-panel [data-file]');
        if (await fileActions.count()) {
          await fileActions.first().dispatchEvent('click');
          await expectNativePanelOpen(page, 'Files row action');
        } else {
          expect(panelText).toMatch(/Files|Empty directory|Read directory failed/i);
        }
      }
    }

    expectNoForbiddenRuntimeErrors(runtimeErrors);
  });
});
