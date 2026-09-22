// coverage: docs/TESTING.md
// seed: e2e/seed.spec.ts

import { test, expect } from '@playwright/test';
import { APPROVAL_OPTIONS, SANDBOX_OPTIONS } from '../public/js/util/cli-settings.js';

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



test.describe('Popovers And Slash Suggestions', () => {
  test('Popovers And Slash Suggestions', async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);

    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    // 1. Type `/` into `#msg-input`.
    const input = page.locator('#msg-input');
    await expect(input).toBeVisible();
    await input.pressSequentially('/');
    const slashPopup = page.locator('#slash-popup');
    await expect(slashPopup).toBeVisible();
    for (const command of ['/model', '/diff', '/compact', '/files', '/mcp']) {
      await expect(slashPopup.locator(`.slash-item[data-cmd="${command}"]`).first(), `${command} slash item should be visible`).toBeVisible();
    }
    await expect(slashPopup.locator('.slash-item[data-cmd="/plan"]')).toHaveCount(0);
    // /status 与 /permissions 和 /model 打开同一个 sheet，列表里只留一个；别名仍然解析得动，
    // 那条契约由 test/unit/slash-commands.test.mjs 守。
    await expect(slashPopup.locator('.slash-item[data-cmd="/status"]')).toHaveCount(0);

    // 2. 点条目 = 执行命令。旧行为是把 "/model " 塞回输入框等用户按发送，
    //    一发就变成给模型的一句普通文本——app-server 不解析斜杠命令（实测过：模型会
    //    照字面「扮演」执行，服务端零动作）。
    await slashPopup.locator('.slash-item[data-cmd="/model"]').first().click();
    await expect(page.locator('#session-settings')).toBeVisible();
    await expect(input).toHaveValue('');
    await expect(page.locator('.msg.user')).toHaveCount(0);
    await page.locator('#session-settings-close').click();
    await expect(page.locator('#session-settings')).toBeHidden();

    const defaults = page.locator('[data-testid="composer-defaults"]');
    await expect(defaults).toBeVisible();
    const defaultsBox = await defaults.boundingBox();
    expect(defaultsBox.height, 'composer chips must stay on one line').toBeLessThanOrEqual(40);
    await expect(page.locator('#model-trigger-text')).not.toHaveText('');
    await expect(page.locator('#model-trigger-text')).not.toHaveText('模型');
    await expect(page.locator('#perm-trigger-text')).toHaveText('请求批准');
    await expect(page.locator('#effort-trigger')).toBeHidden();

    await defaults.click();
    await expect(page.locator('#session-settings')).toBeVisible();
    await expect(page.locator('#mode-list')).toHaveCount(0);
    await page.locator('#settings-advanced summary').click();
    await expect(page.locator('.msg.user')).toHaveCount(0);
    await expect(page.locator('#state-label')).toHaveText('idle');
    // 遍历真实选项而不是重述清单：协议增删一个档位不该让这条断言失效或漏检。
    for (const { id } of APPROVAL_OPTIONS) {
      await expect(page.locator(`#approval-list [data-approval="${id}"]`)).toBeVisible();
    }
    for (const { id } of SANDBOX_OPTIONS) {
      await expect(page.locator(`#sandbox-list [data-sandbox="${id}"]`)).toBeVisible();
    }
    const miniModel = page.locator('#model-list .popover-item[data-model="gpt-5.4-mini"]').first();
    await expect(miniModel).toBeVisible({ timeout: 10000 });
    await miniModel.click();
    await expect(page.locator('#model-trigger-text')).toContainText('5.4-Mini');
    await page.locator('#session-settings-close').click();
    await expect(page.locator('#session-settings')).toBeHidden();
    await expect(page.locator('.msg.user')).toHaveCount(0);
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
    await input.fill('/plan');
    await input.press('Enter');
    await expect(page.locator('.msg.user')).toHaveCount(0);
    await expect(page.locator('.msg.system-msg.error-msg').last()).toContainText('/plan');
    await expect(page.locator('#msg-input')).toHaveValue('/plan');

    expectNoForbiddenRuntimeErrors(runtimeErrors);
  });

  // 真机上 Codex 只在 serviceTiers 里返回加速档，"标准"是隐式的未设置态。以前照数组
  // 直传，面板里就只剩孤零零一个 Fast：没有勾、也没有回到默认的入口，想退回去只能
  // 再点一次同一行。这条盯的是那个面板长什么样。
  test('Speed Group Shows A Selectable Default Row', async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);

    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await page.locator('[data-testid="composer-defaults"]').click();
    await expect(page.locator('#session-settings')).toBeVisible();

    const speedList = page.locator('#speed-list');
    await expect(page.locator('#speed-section-label')).toHaveText('速度');
    await expect(speedList.locator('.popover-item')).toHaveCount(2, { timeout: 10000 });

    // 标准档的 data-speed 是空串（表示不下发 serviceTier）。CSS 的 [data-speed=""]
    // 匹配不到它，用它写断言只会拿到一片假绿，所以这里按位置取行、再验属性值。
    const standard = speedList.locator('.popover-item').first();
    const fast = speedList.locator('.popover-item[data-speed="fast"]');
    await expect(standard).toHaveAttribute('data-speed', '');
    await expect(standard.locator('.popover-item-title')).toHaveText('标准');
    await expect(standard.locator('.popover-item-desc')).toHaveText('默认速度');
    await expect(fast.locator('.popover-item-title')).toHaveText('快速');
    await expect(fast.locator('.popover-item-desc')).toHaveText('1.5 倍速度，用量更多');
    await expect(standard, '没选过时默认档就该是勾上的那一行').toHaveClass(/selected/);

    // 普通单选：勾能过去，也能点回来。
    await fast.click();
    await expect(fast).toHaveClass(/selected/);
    await expect(standard).not.toHaveClass(/selected/);
    await standard.click();
    await expect(standard).toHaveClass(/selected/);
    await expect(fast).not.toHaveClass(/selected/);

    // 上游自己把默认档列出来的模型，不能再多补一条重复的「标准」。
    await page.locator('#model-list .popover-item[data-model="gpt-5.4"]').first().click();
    await expect(speedList.locator('.popover-item')).toHaveCount(2);
    await expect(speedList.locator('.popover-item').first()).toHaveAttribute('data-speed', 'standard');
    await expect(speedList.locator('.popover-item[data-speed="standard"]')).toHaveClass(/selected/);

    // 完全不支持档位的模型，整组照旧不显示。
    await page.locator('#model-list .popover-item[data-model="gpt-5.4-mini"]').first().click();
    await expect(page.locator('#speed-section-label')).toBeHidden();
    await expect(speedList).toBeHidden();

    expectNoForbiddenRuntimeErrors(runtimeErrors);
  });
});

test.describe('细粒度审批与恢复默认', () => {
  // 0.147.0 新增的 granular 对象变体。判据是可见画面：勾选后该项高亮，恢复默认后全部清空。
  test('细粒度开关可勾选，恢复默认把覆盖清空', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });
    await page.locator('[data-testid="composer-defaults"]').click();
    await expect(page.locator('#session-settings')).toBeVisible();

    await page.locator('#settings-advanced summary').click();
    const sandboxApproval = page.locator('#granular-list [data-granular="sandbox_approval"]');
    await expect(sandboxApproval).toBeVisible();
    await expect(sandboxApproval).not.toHaveClass(/selected/);
    await sandboxApproval.click();
    await expect(sandboxApproval).toHaveClass(/selected/);

    // 五个开关都在，缺一个 app-server 就会拒掉整个 turn。
    for (const key of ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations']) {
      await expect(page.locator(`#granular-list [data-granular="${key}"]`)).toBeVisible();
    }

    await page.locator('[data-permission="host"]').click();
    await expect(sandboxApproval).not.toHaveClass(/selected/);
  });
});

// app-server 不解析斜杠命令（那是 codex TUI 层的东西），所以没接线的命令一旦
// 被当成普通消息发出去，用户会以为自己执行了命令，其实只是往对话里塞了句话。
test.describe('斜杠命令兜底', () => {
  test('接不了的斜杠命令当场报错，不会变成发给模型的消息', async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);

    await page.goto('/');
    await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

    const input = page.locator('#msg-input');
    const errors = page.locator('.msg.system-msg.error-msg');

    // codex 有、手机端没接的命令：要说清改用什么，草稿留着别弄丢。
    await input.fill('/init');
    await input.press('Enter');
    await expect(errors).toHaveCount(1);
    await expect(errors.first()).toContainText('/init');
    await expect(input).toHaveValue('/init');
    await expect(page.locator('.msg.user')).toHaveCount(0);

    // 压根不存在的命令：同样拦下，并指路 `/` 本身（/help 已随实现删除——它的实现就是
    // 把输入框设成 / 再弹一次挑选层，等于 / 自己）。
    await input.fill('/nope');
    await input.press('Enter');
    await expect(errors).toHaveCount(2);
    await expect(errors.nth(1)).toContainText('输入 /');
    await expect(page.locator('.msg.user')).toHaveCount(0);


    // 绝对路径不是命令意图——误判会把正常消息拦下来。
    await input.fill('/usr/bin/codex 这个路径不对');
    await input.press('Enter');
    await expect(page.locator('.msg.user')).toHaveCount(1);

    expectNoForbiddenRuntimeErrors(runtimeErrors);
  });

  // review 走 inline：结果作为当前会话的一个 turn 流回来，不产生 user 气泡，
  // 也不需要为一条 review thread 单独订阅。
  test('/review 发起审查，结果沿当前会话的事件流回来', async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);

    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    const input = page.locator('#msg-input');

    // 先落一条普通消息，让会话和 thread 真实存在——review 的结果要流进这条会话。
    await input.fill('hello');
    await input.press('Enter');
    await expect(page.locator('.msg.codex').last()).toContainText('Mock response to: hello', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // 无参数：审未提交改动。
    await input.fill('/review');
    await input.press('Enter');
    await expect(input).toHaveValue('');
    await expect(page.locator('.msg.system-msg').last()).toContainText('已发起未提交改动审查');
    await expect(page.locator('.msg.codex').last()).toContainText('未提交改动审查', { timeout: 10000 });
    // 命令本身不该变成一条发给模型的消息：user 气泡还是开头那条 hello。
    await expect(page.locator('.msg.user')).toHaveCount(1);
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // 结果要完整：首个 delta 曾经被事件路由丢掉，表现是稳定少第一个字符。
    await expect(page.locator('.msg.codex').last()).toContainText('Mock response to:', { timeout: 10000 });

    // 带参数：当自定义审查指令透传下去。
    await input.fill('/review 重点看并发安全');
    await input.press('Enter');
    await expect(page.locator('.msg.codex').last()).toContainText('按指令审查 重点看并发安全', { timeout: 10000 });
    await expect(page.locator('.msg.user')).toHaveCount(1);
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // 两次审查是两个独立回合，不能续写进同一个气泡。
    const bubbles = await page.locator('.msg.codex .bubble').allTextContents();
    const reviewBubbles = bubbles.filter(t => t.includes('REVIEW_FIXTURE'));
    expect(reviewBubbles.length, '两次 review 应各自成一个气泡').toBe(2);
    for (const t of reviewBubbles) {
      expect(t.startsWith('Mock response to:'), `气泡开头被截断或拼接：${t.slice(0, 40)}`).toBe(true);
    }

    expectNoForbiddenRuntimeErrors(runtimeErrors);
  });
});

// codex 的 `/` 命令表是 TUI 硬编码的，app-server 一个字都不上报，所以内置那几条只能写死。
// 真正天天变的是用户自己加的 skill —— skills/list 能拉、skills/changed 会推，那一段才是
// 「上游更新不用管」真正成立的地方。两段必须并在同一个挑选层里，否则 skill 就只能从
// 「抽屉 → 设置与状态 → 技能 → 插入」四层菜单进去。
test('斜杠挑选层把内置命令和动态 skill 并成两段', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await page.locator('#msg-input').fill('/');
  const popup = page.locator('#slash-popup');
  await expect(popup).toHaveClass(/show/);

  await expect(popup.locator('.slash-item[data-kind="builtin"]').first()).toBeVisible();
  await expect(popup.locator('.slash-item[data-cmd="/archify"]'), 'skill 要出现在挑选层里')
    .toBeVisible({ timeout: 10000 });
  await expect(popup.locator('.slash-item[data-cmd="/disabled-one"]'), '未启用的 skill 不该列出')
    .toHaveCount(0);

  // 同义别名只留一个，/help 已随实现删除
  await expect(popup.locator('.slash-item[data-cmd="/status"]')).toHaveCount(0);
  await expect(popup.locator('.slash-item[data-cmd="/help"]')).toHaveCount(0);
  await expect(popup.locator('.slash-item[data-cmd="/model"]')).toHaveCount(1);
});

// 选中 skill 绝不能走 sendMessage —— 那等于把 "/archify" 当一句话发给模型，而模型会照着
// 字面「扮演」执行（实测过：回一句「已压缩上下文」，服务端一个动作都没有）。
test('选中 skill 插入结构化输入，不把命令名当消息发出去', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#state-label')).not.toHaveText('offline', { timeout: 10000 });

  await page.locator('#msg-input').fill('/');
  const skillItem = page.locator('#slash-popup .slash-item[data-cmd="/archify"]');
  await expect(skillItem).toBeVisible({ timeout: 10000 });
  await skillItem.click();

  await expect(page.locator('#msg-input'), '输入框要被清空，等用户接着写指令').toHaveValue('');
  await expect(page.locator('#messages'), '不能把 /archify 当消息发出去')
    .not.toContainText('/archify');
  // 挂成输入部件的 chip。前缀是 $ 不是 / —— / 只是挑选层的触发符，$ 才是 codex 里
  // skill 的身份标识，插入后显示 $ 与 CLI 一致。
  await expect(page.locator('#attach-tray'), 'skill 应作为输入部件挂上')
    .toContainText('$archify', { timeout: 5000 });
});
