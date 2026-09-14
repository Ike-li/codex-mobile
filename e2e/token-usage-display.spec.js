// e2e/token-usage-display.spec.js —— token 用量的归属：状态栏，不是消息流。
// coverage: docs/TESTING.md
//
// 2026-09-10 的实际故障：handleUsage 对每条 thread/tokenUsage/updated 都调
// appendSystem(`Token usage: ${total}`)。而 `last.totalTokens` 是**当前上下文
// 的快照**（每次请求重发全部历史，所以单调递增），不是本轮增量——真实日志里
// 101 条事件对 7 个 turn。于是用户问一个问题，消息流就多出十几个气泡，内容是
// 同一件事的十几个版本，前面每一条在被下一条取代的瞬间就成了垃圾。
//
// 这两条断言分别守住「不再淹没消息流」和「用量仍然可见」——只守前者的话，
// 把 handleUsage 整个删掉也能绿，而那会让上下文占用彻底不可见。
import { test, expect } from '@playwright/test';

async function connect(page) {
  await page.goto('/');
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
}

async function sendMessage(page, text) {
  await page.locator('#msg-input').fill(text);
  await page.locator('#send-btn').click();
}

test.describe('token 用量的展示位置', () => {
  test('用量更新不进消息流', async ({ page }) => {
    await connect(page);
    await sendMessage(page, 'token usage should not spam the transcript');
    await expect(page.locator('.msg.codex').last())
      .toContainText('Mock response to:', { timeout: 10000 });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // mock 每轮推 3 条 tokenUsage；一条气泡都不该出现。
    await expect(page.locator('.msg.system-msg').filter({ hasText: 'Token usage' }))
      .toHaveCount(0);
  });

  test('上下文占用显示在 composer 上且不是 0', async ({ page }) => {
    await connect(page);
    await sendMessage(page, 'context meter should update');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // toBeVisible 是这条测试的重点，不是顺手加的：改动过程中 meter 一度被写进
    // #status-detail —— 那个元素是 display:none 且全表没有规则打开它，textContent
    // 断言全绿而用户什么都看不到。断言「有值」不足以证明「看得见」。
    const meter = page.getByTestId('context-meter');
    await expect(meter).toBeVisible({ timeout: 10000 });
    // 用量从数字胶囊改成了圆环（抄 ChatGPT 的 contextUsageIndicator），环上没有
    // 文字，具体数字退到 title。坏掉的 contextCost 会让这里恒为「已用 0.0k」——
    // 要能区分「真实值」和「可信的零」。
    await expect(meter).toHaveAttribute('title', /共 272k$/);
    await expect(meter).not.toHaveAttribute('title', /已用 0/);
    // 还要验环真的按比例画：--pct 是 CSS conic-gradient 的唯一输入，它停在 0
    // 的话 title 再对也只是一个空心圈。
    const pct = await meter.evaluate(el => Number(el.style.getPropertyValue('--pct')));
    expect(pct, `--pct 是 ${pct}，环没有按比例填充`).toBeGreaterThan(0);
    expect(pct).toBeLessThanOrEqual(100);
  });
});
