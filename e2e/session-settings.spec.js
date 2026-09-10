import { test, expect } from '@playwright/test';

test('permission presets require confirmation, persist and keep advanced controls collapsed', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-testid="composer-defaults"]').click();
  const full = page.locator('[data-permission="full-access"]');
  await expect(full).toBeEnabled();
  await expect(page.locator('#granular-list')).toBeHidden();
  await page.screenshot({ path: test.info().outputPath('settings-overview.png') });
  await full.click();
  await expect(page.locator('#confirm-modal')).toBeVisible();
  await page.locator('#confirm-modal').getByRole('button', { name: /取消/ }).click();
  await expect(full).not.toHaveClass(/selected/);
  await page.locator('[data-permission="auto-review"]').click();
  await expect(page.locator('#perm-trigger-text')).toHaveText('帮我批准');
  await page.reload();
  await expect(page.locator('#perm-trigger-text')).toHaveText('帮我批准');
  await page.locator('[data-testid="composer-defaults"]').click();
  await expect(page.locator('[data-mode="plan"]')).toBeDisabled();
  await page.locator('#settings-advanced summary').click();
  await page.locator('[data-granular="rules"]').click();
  await expect(page.locator('#perm-trigger-text')).toHaveText('自定义');
  await page.reload();
  await page.locator('[data-testid="composer-defaults"]').click();
  await page.locator('#settings-advanced summary').click();
  await expect(page.locator('[data-granular="rules"]')).toHaveClass(/selected/);
  await page.screenshot({ path: test.info().outputPath('session-settings.png') });
});

// 这条测试间歇性红（实测约 1/3，两个引擎都出现过），失败形态永远是最后那句
// 「主机配置已应用」超时、实际停在「所选设置将在下一轮生效」。
//
// 卡在诊断上的原因是它只断言最终文本：turn/start 若中途失败，startTurnDispatch 的
// catch 会 `Object.assign(this, previousSettings)` 把 turnOverrides 回滚到上一轮
// （即 full-access），于是 effectivePermissions.source 保持 'session'，而
// permission-state 需要 source==='host' 才显示「主机配置已应用」。整条链路唯一的
// 外部痕迹是一条 error 气泡，而此前没有任何断言看它——于是失败信息只剩一句文本不匹配。
//
// 下面每轮发送后的 error-msg 断言就是为此：它把「turn 根本没起来」和「起来了但
// 状态没更新」区分开。两者的修法完全不同，混在一起没法查。
//
// 【2026-09-10 复现一次，结论：上面那条回滚路径被排除】两条 error-msg 断言双双通过，
// 失败仍停在最后一句——turn/start **没有**失败，catch 回滚从未发生。原先写在这里的
// 假设（readSessionSettings 的 RPC 在高负载下失败 → host 模式 enabled=false →
// 抛「权限模式不可用」）随之证伪，已删除，别再往那个方向查。
//
// 剩下的方向：turn 成功了，但 sessionStatus.effectivePermissions.source 仍是上一轮的
// 'session'，或者 selectedPermission 被 adoptEffectivePermission 改离了 'host'
// （permissionModeForSettings 永远不会返回 'host'——PERMISSION_PRESETS 里没有它，
// 所以只要在 source!=='host' 时 adopt 一次，选择就丢了）。permission-state 那行要求
// 两者同时成立才显示「主机配置已应用」（public/js/app.js renderCliSettingsPopovers）。
// 下次复现该抓的是这两个值，不是再看有没有报错。
//
// 已排除，别重走：① turn/start 失败后 catch 回滚（见上，error-msg 断言证伪）；
// ② control agent 与 viewing agent 的 status 串台——socket 确实会同时待在两个
// instance room 里，但 processAgentEvent 在分发前先过 eventMatchesTarget 按
// instanceId 过滤，别的 runtime 的 status 到不了 handleStatus。
test('full access and host reset become effective only after a new turn', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-testid="composer-defaults"]').click();
  await page.locator('[data-permission="full-access"]').click();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('#permission-state')).toContainText('下一轮');
  await page.locator('#session-settings-close').click();
  await page.locator('#msg-input').fill('hello permissions');
  await page.locator('#msg-input').press('Enter');
  await expect(page.locator('.msg.user')).toHaveCount(1);
  // 必须等到助手回复真的出现，才算这一轮跑完。
  // 只断言 #state-label 是 idle 不够：turn 尚未开始时它同样是 idle，断言会立刻通过，
  // 于是下一轮的权限选择和发送可能落在第一轮仍在跑的时候——那时 dispatchUserMessage
  // 走的是 steerTurnDispatch，而它压根不接收 turn 参数，permission:{mode:'host'}
  // 会被整个丢掉（不 applyTurnOverrides、不 resolveHostPermissions、
  // 不 rememberEffectivePermissions）。这正是本用例长期间歇性红的成因。
  await expect(page.locator('.msg.codex').last()).toContainText('hello permissions');
  await expect(page.locator('#state-label')).toHaveText('idle');
  await expect(page.locator('.error-msg'), 'turn/start 失败会回滚权限覆盖，后面的状态断言就失去意义').toHaveCount(0);
  await page.locator('[data-testid="composer-defaults"]').click();
  await expect(page.locator('#permission-state')).toHaveText('当前已生效');
  await expect(page.locator('#permission-effective')).toContainText('dangerFullAccess');
  await page.locator('[data-permission="host"]').click();
  // 点击可能被静默吞掉：permission-list 的 handler 里有
  //   `if (!capability?.enabled) return;`（public/js/app.js）
  // 按钮的 disabled 属性来自上一次 renderCliSettingsPopovers，而 handler 读的是
  // 当次的 settingsCapabilities——两者不同步时，按钮看着可点、点了却什么都不发生，
  // selectedPermission 仍停在 full-access。不钉住这一步，后面所有断言都在替它背锅。
  await expect(page.locator('[data-permission="host"]'), '点了 host 但没被选中——点击被 capability 门控吞掉了')
    .toHaveClass(/selected/);
  await page.locator('#session-settings-close').click();
  await page.locator('#msg-input').fill('hello host defaults');
  await page.locator('#msg-input').press('Enter');
  await expect(page.locator('.msg.user')).toHaveCount(2);
  await expect(page.locator('.msg.codex').last()).toContainText('hello host defaults');
  await expect(page.locator('#state-label')).toHaveText('idle');
  await expect(page.locator('.error-msg'), 'turn/start 失败会回滚权限覆盖，下一句的「主机配置已应用」必然落空').toHaveCount(0);
  await page.locator('[data-testid="composer-defaults"]').click();
  // 下面那句「主机配置已应用」要求 selectedPermission==='host' **且**
  // effectivePermissions.source==='host' 同时成立，两者任一不成立都显示同一句
  // 「所选设置将在下一轮生效」——这正是这个 flaky 一直难定位的原因。
  //
  // #permission-effective 的内容就是 JSON.stringify(sessionStatus.effectivePermissions)，
  // 所以先单独钉住 source 这一半，把二分做完：这条先红 = 服务端没把 source 更新成
  // host；这条绿而下一条红 = applied 是对的，selectedPermission 被 adopt 改走了。
  // 用 textContent 轮询而不是 toContainText：此刻 #settings-advanced 还没展开。
  await expect
    .poll(async () => (await page.locator('#permission-effective').textContent()) || '',
      { message: 'effectivePermissions.source 应为 host' })
    .toMatch(/"source":\s*"host"/);
  await expect(page.locator('#permission-state')).toContainText('主机配置已应用');
  await page.locator('#settings-advanced summary').click();
  await expect(page.locator('#permission-effective')).toContainText('workspaceWrite');
  await expect(page.locator('#permission-effective')).not.toContainText('dangerFullAccess');
});
