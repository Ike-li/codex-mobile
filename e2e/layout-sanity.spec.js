// e2e/layout-sanity.spec.js —— 布局体检的绊线用例。
//
// coverage: docs/TESTING.md
//
// 这里放的是「读不读得了」那一类判据，和 markdown-typography.spec.js 的「会不会崩」
// 互补。后者曾经四条断言全绿，而宽表格的中文列被挤到 49px 宽、压成一根竖条。
import { test, expect } from '@playwright/test';
import { auditLayout, formatIssues } from './lib/layout-audit.js';

async function sendAndRender(page, prompt, ready) {
  await page.goto('/');
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  await page.locator('#msg-input').fill(prompt);
  await page.locator('#send-btn').click();
  await expect(ready(page)).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
}

test('宽表格的每一列都读得了，没有被挤成竖条的正文', async ({ page }) => {
  await sendAndRender(page, 'RICH_MARKDOWN_FIXTURE', p => p.locator('.msg.codex .bubble.md table').last());

  const { scanned, issues } = await auditLayout(page, '.msg.codex .bubble.md');

  expect(issues, formatIssues('.msg.codex .bubble.md', issues)).toEqual([]);
  // 这块区域确实满是文字，扫到 0 个就是失明。auditLayout 内部也会把这种情况报成
  // scan-collapsed，这里再钉一次是因为 fixture 一旦被改空，上面那条会平凡地通过。
  expect(scanned, '富文本气泡里应该扫到大量文本元素').toBeGreaterThan(10);
});
