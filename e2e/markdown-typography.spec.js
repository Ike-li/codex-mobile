// e2e/markdown-typography.spec.js —— 助手回复里 Markdown 元素的排版守护。
//
// marked 配置开了 gfm: true,表格/标题/引用/分隔线都会真的产出,但样式表原本只给
// p / ul,ol / pre / code / a 写了规则,其余元素全走浏览器默认样式。其中表格最要命:
// 默认 <table> 按内容宽度撑开,长表格会直接把 720px 阅读栏撑破。
//
// coverage: docs/TESTING.md
import { test, expect } from '@playwright/test';

// 发送后直接等 #state-label === 'idle' 会平凡通过 —— 发送前它本来就是 idle。
// 必须等到渲染产物出现,断言才落在真实 DOM 上。
async function sendAndRender(page, prompt, ready) {
  await page.goto('/');
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  await page.locator('#msg-input').fill(prompt);
  await page.locator('#send-btn').click();
  await expect(ready(page)).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
}

test.describe('助手回复的 Markdown 排版', () => {
  test('宽表格自己横向滚动,不撑破阅读栏', async ({ page }) => {
    await sendAndRender(page, 'RICH_MARKDOWN_FIXTURE', p => p.locator('.msg.codex .bubble.md table').last());

    const bubble = page.locator('.msg.codex .bubble.md').last();
    // 滚动容器是表格外面那层 .table-scroll,不是 <table> 自己。合成一个元素时
    // (display: block + max-width: 100%),max-width 夹住的是内部表格算法的可用宽度,
    // 表格不知道外面能滚,于是在阅读栏宽度里硬分列,中文列被压到 49px 成一根竖条。
    const scroller = bubble.locator('.table-scroll');

    const overflow = await scroller.evaluate(el => {
      const win = el.ownerDocument.defaultView;
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowX: win.getComputedStyle(el).overflowX,
        cellWordBreak: win.getComputedStyle(el.querySelector('tbody td')).wordBreak,
        // 表格自己必须取 max-content,不被容器夹窄——这才是列宽不被挤压的前提。
        tableWidth: Math.round(el.querySelector('table').getBoundingClientRect().width),
      };
    });
    // .bubble 的 word-break: break-word 会继承进单元格,把 min-content 压到一个字符宽,
    // 于是表格永远"挤得下"、overflow-x 永远不触发,列被压成 ~94px 且长路径从中间断开。
    // 这条复位是 overflow-x 能生效的前提。
    expect(overflow.cellWordBreak, '单元格必须复位继承来的 word-break').toBe('normal');
    // 再证明这份 fixture 真的够宽 —— 否则"没撑破"会平凡地成立。
    expect(overflow.scrollWidth, '表格内容应宽于其可视宽度,fixture 才有守护意义')
      .toBeGreaterThan(overflow.clientWidth);
    expect(overflow.overflowX, '溢出应由滚动容器横向滚动消化').toBe('auto');
    expect(overflow.tableWidth, '表格应取 max-content 宽度,而不是被夹到容器宽度后挤压列')
      .toBeGreaterThan(overflow.clientWidth);

    // 破版的判据:表格撑破消息 ⇒ #messages 出现横向溢出。
    const messages = await page.locator('#messages').evaluate(el => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(
      messages.scrollWidth,
      `阅读栏不应被表格撑出横向滚动(${messages.scrollWidth} > ${messages.clientWidth})`,
    ).toBeLessThanOrEqual(messages.clientWidth + 1);

    const bubbleBox = await bubble.boundingBox();
    const messagesBox = await page.locator('#messages').boundingBox();
    expect(bubbleBox.width).toBeLessThanOrEqual(messagesBox.width + 1);
  });

  test('标题层级克制,引用/分隔线/列表都有设计样式', async ({ page }) => {
    await sendAndRender(page, 'RICH_MARKDOWN_FIXTURE', p => p.locator('.msg.codex .bubble.md blockquote').last());

    const bubble = page.locator('.msg.codex .bubble.md').last();
    const typography = await bubble.evaluate(el => {
      const win = el.ownerDocument.defaultView;
      const px = (node, prop) => parseFloat(win.getComputedStyle(node)[prop]);
      return {
        body: px(el, 'fontSize'),
        h1: px(el.querySelector('h1'), 'fontSize'),
        h2: px(el.querySelector('h2'), 'fontSize'),
        blockquoteBorder: px(el.querySelector('blockquote'), 'borderLeftWidth'),
        blockquotePad: px(el.querySelector('blockquote'), 'paddingLeft'),
        hrBorder: px(el.querySelector('hr'), 'borderTopWidth'),
        firstChildMarginTop: px(el.firstElementChild, 'marginTop'),
      };
    });

    // 浏览器默认 h1 是 2em(=30px)且带 0.67em 上下外边距 —— 在对话流里过于喧宾夺主。
    expect(typography.h1).toBeGreaterThan(typography.body);
    expect(typography.h1, `h1 应克制在正文 1.5 倍以内(实测 ${typography.h1}/${typography.body})`)
      .toBeLessThanOrEqual(typography.body * 1.5);
    expect(typography.h2).toBeLessThan(typography.h1);
    expect(typography.h2).toBeGreaterThan(typography.body);

    expect(typography.blockquoteBorder, 'blockquote 应有左边框').toBeGreaterThan(0);
    expect(typography.blockquotePad, 'blockquote 左边框和文字之间要留白').toBeGreaterThan(0);
    expect(typography.hrBorder, 'hr 应是一条 1px 细线').toBeGreaterThan(0);
    // 第一个块级元素是 h1,它的上外边距必须归零,否则气泡顶部会凭空多出一段空白。
    expect(typography.firstChildMarginTop, '首个子元素不应有上外边距').toBe(0);
  });

  test('用户气泡与助手正文各自配行高', async ({ page }) => {
    await sendAndRender(page, 'TYPOGRAPHY_FIXTURE', p => p.locator('.msg.codex .bubble.md').last());
    await expect(page.locator('.msg.user .bubble').last()).toBeVisible();

    const metrics = await page.evaluate(() => {
      const doc = globalThis.document;
      const win = doc.defaultView;
      const read = node => {
        const style = win.getComputedStyle(node);
        return {
          fontSize: parseFloat(style.fontSize),
          lineHeight: parseFloat(style.lineHeight),
          fontFamily: style.fontFamily,
        };
      };
      const users = doc.querySelectorAll('.msg.user .bubble');
      const codex = doc.querySelectorAll('.msg.codex .bubble.md');
      return {
        user: read(users[users.length - 1]),
        codex: read(codex[codex.length - 1]),
      };
    });

    // 用户消息是紧凑气泡:字号小一档,行高不能沿用为 15px 正文定的 1.55。
    expect(metrics.user.fontSize).toBeLessThan(metrics.codex.fontSize);
    expect(
      metrics.user.lineHeight / metrics.user.fontSize,
      '紧凑气泡的行高比应低于长文阅读态',
    ).toBeLessThan(metrics.codex.lineHeight / metrics.codex.fontSize);
  });

  test('reasoning 正文保持无衬线,没有掉回 <pre> 的等宽默认字体', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    await page.locator('#msg-input').fill('REASONING_STREAM_FIXTURE');
    await page.locator('#send-btn').click();

    const body = page.locator('.reasoning-body').last();
    await expect(body).toBeAttached({ timeout: 10000 });

    // .reasoning-body 的宿主是 <pre>。原本靠 `font: 13px/1.5 inherit` 简写里的 inherit
    // 压掉 UA 的等宽默认;拆成长写法时必须显式保留 font-family: inherit。
    const fonts = await body.evaluate(el => {
      const win = el.ownerDocument.defaultView;
      return {
        body: win.getComputedStyle(el).fontFamily,
        root: win.getComputedStyle(el.ownerDocument.body).fontFamily,
      };
    });
    expect(fonts.body).toBe(fonts.root);
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });
  });
});
