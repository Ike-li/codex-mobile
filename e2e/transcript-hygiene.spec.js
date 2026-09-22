// e2e/transcript-hygiene.spec.js —— 消息流只承载对话。
//
// mock 的 TOOL_CARDS_FIXTURE 含一个协议里没有的 item type。旧行为是在对话里
// 长一张 Raw JSON 卡；那把「没认出来」变成了用户必须读的正文。
import { test, expect } from '@playwright/test';

async function connect(page) {
  await page.goto('/');
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
}

async function sendAndIdle(page, text) {
  await page.locator('#msg-input').fill(text);
  await page.locator('#send-btn').click();
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 20000 });
}

test.describe('消息流准入', () => {
  test('普通回复不夹系统气泡或 Raw JSON', async ({ page }) => {
    await connect(page);
    await sendAndIdle(page, 'hello world');
    await expect(page.locator('.msg.codex').filter({ hasText: 'Mock response to: hello world' }).last())
      .toBeVisible();
    await expect(page.locator('.msg.system-msg')).toHaveCount(0);
    await expect(page.locator('#messages')).not.toContainText('Raw:');
    const copyBtn = page.locator('.turn-action[data-action="copy"]').last();
    await expect(copyBtn).toBeVisible();
    await expect(copyBtn).toContainText('复制');
  });

  test('未识别的协议 item 不进消息流', async ({ page }) => {
    await connect(page);
    await sendAndIdle(page, 'UNKNOWN_ITEM_FIXTURE');
    await expect(page.locator('.msg.codex').filter({ hasText: 'unknown item ignored' }).last())
      .toBeVisible();
    await expect(page.locator('#messages')).not.toContainText('Raw:');
    await expect(page.locator('[data-activity="raw"]')).toHaveCount(0);
    await expect(page.locator('.tool-json')).toHaveCount(0);
  });

  test('本轮结果完整落在消息流视口里，不被输入框挡住', async ({ page }) => {
    await connect(page);
    await sendAndIdle(page, 'FILE_CHANGE_FIXTURE');
    const card = page.locator('.tool-card[data-card="outcome"]').last();
    await expect(card).toBeVisible();
    const geometry = await page.evaluate(() => {
      const el = [...globalThis.document.querySelectorAll('.tool-card[data-card="outcome"]')].at(-1);
      const frame = globalThis.document.querySelector('#messages');
      const er = el.getBoundingClientRect();
      const fr = frame.getBoundingClientRect();
      return {
        cardTop: er.top,
        cardBottom: er.bottom,
        frameTop: fr.top,
        frameBottom: fr.bottom,
      };
    });
    expect(geometry.cardBottom, '结果卡底边落到输入区下面了')
      .toBeLessThanOrEqual(geometry.frameBottom + 1);
    expect(geometry.cardTop, '结果卡整张都在视口上方，等于没滚到位')
      .toBeLessThan(geometry.frameBottom);
  });
});
