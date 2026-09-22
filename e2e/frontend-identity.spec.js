// e2e/frontend-identity.spec.js —— 视觉身份：这是 Codex 手机工作台，不是聊天模板。
//
// 守的是用户一眼能辨认的几件事：空状态怎么开口、建议怎么排、我说的话长什么样。
// 色值和字号的对比度由 contrast.js / layout-audit 另守；这里只问「像不像这款产品」。
//
// coverage: docs/TESTING.md
import { test, expect } from '@playwright/test';
import { contrastRatio, parseRgb } from './lib/contrast.js';

function chroma(value) {
  const [r, g, b] = parseRgb(value);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

test.describe('空状态是工作台，不是聊天落地页', () => {
  test('标题用衬线家族，开口是这一轮要改什么', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    const heading = page.locator('#empty-heading');
    await expect(heading).toBeVisible();
    await expect(heading).toHaveText('这轮改什么？');

    const stack = await heading.evaluate(
      el => globalThis.getComputedStyle(el).fontFamily,
    );
    const declared = stack.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    const serifHits = declared.filter(f => (
      f === 'ui-serif'
      || f === 'Iowan Old Style'
      || f === 'Songti SC'
      || f === 'Songti TC'
      || f === 'Noto Serif SC'
      || f === 'Source Han Serif SC'
      || f === 'STSong'
    ));
    expect(
      serifHits.length,
      `空状态标题没有声明衬线家族，会落到和正文同一套系统无衬线：${stack}`,
    ).toBeGreaterThan(0);

    const genericIdx = declared.findIndex(f => f === 'serif' || f === 'sans-serif');
    if (genericIdx >= 0) {
      const firstSerifCjk = declared.findIndex(f => (
        f === 'Songti SC' || f === 'Songti TC' || f === 'Noto Serif SC'
        || f === 'Source Han Serif SC' || f === 'STSong'
      ));
      expect(
        firstSerifCjk,
        `中文衬线排在通用兜底 "${declared[genericIdx]}" 之后就永远轮不到：${stack}`,
      ).toBeLessThan(genericIdx);
    }
  });

  test('空状态不放通用聊天建议', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
    await expect(page.locator('#empty-heading')).toBeVisible();
    await expect(page.locator('.suggestion-card')).toHaveCount(0);
    await expect(page.locator('#empty-actions')).not.toContainText('探索并理解代码');
  });

  test('回空会话后可以继续上次会话', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
    await page.locator('#msg-input').fill('HEADER_HOME_CLEAR');
    await page.locator('#send-btn').click();
    await expect(page.locator('.msg.user').filter({ hasText: 'HEADER_HOME_CLEAR' })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
    await page.locator('#header-new').click();
    await expect(page.locator('#empty-state')).toBeVisible();
    const resume = page.locator('[data-empty-action="continue"]');
    await expect(resume).toBeVisible();
    await expect(resume).toContainText('继续上次会话');
  });

  test('输入框占位符邀请写任务，而不是闲聊', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
    await expect(page.locator('#msg-input'))
      .toHaveAttribute('placeholder', '描述要改的代码');
  });
});

test.describe('用户发言是一张指令条', () => {
  test('浅色下不是聊天蓝气泡，字和底对比够读', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
    await page.locator('#msg-input').fill('只看一眼身份');
    await page.locator('#send-btn').click();
    const bubble = page.locator('.msg.user .bubble').first();
    await expect(bubble).toBeVisible({ timeout: 10000 });

    const style = await bubble.evaluate(el => {
      const cs = el.ownerDocument.defaultView.getComputedStyle(el);
      return { bg: cs.backgroundColor, color: cs.color, shadow: cs.boxShadow };
    });
    const [r, , b] = parseRgb(style.bg);
    expect(
      b - r,
      `用户气泡还是偏蓝的聊天底（${style.bg}）`,
    ).toBeLessThan(16);
    expect(
      chroma(style.bg),
      `用户气泡底色饱和得不像一张指令条（${style.bg}）`,
    ).toBeLessThan(50);
    expect(
      style.shadow,
      `用户气泡没有内侧墨线，看起来仍是一颗聊天气泡（box-shadow: ${style.shadow}）`,
    ).toMatch(/inset/i);
    expect(
      contrastRatio(style.color, style.bg),
      `用户气泡字色 ${style.color} 压在 ${style.bg} 上读不清`,
    ).toBeGreaterThanOrEqual(7);
  });
});
