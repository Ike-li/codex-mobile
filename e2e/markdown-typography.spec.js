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

// 横滑提示的判据：那条边上的像素，在提示样式生效和被关掉时必须不一样。
// 只断言 class / mask-image 字符串会让「HTML 里有、屏幕上没有」再绿一次。
async function edgeHintPaints(page, scroller, side) {
  await scroller.scrollIntoViewIfNeeded();
  const box = await scroller.boundingBox();
  expect(box, '.table-scroll 应在视口里才能拍到边缘').toBeTruthy();

  const strip = 20;
  const height = 28;
  const vp = page.viewportSize();
  const clip = {
    x: Math.round(side === 'right' ? box.x + box.width - strip : box.x),
    y: Math.round(box.y + Math.min(box.height * 0.55, Math.max(0, box.height - height))),
    width: strip,
    height,
  };
  clip.x = Math.max(0, Math.min(clip.x, vp.width - clip.width));
  clip.y = Math.max(0, Math.min(clip.y, vp.height - clip.height));

  // 对照态是**全不透明的 mask**，不是「没有 mask」。这条差别决定这个仪器是否可用：
  // 把 mask 清成 none 会让元素退出离屏合成，文字从灰度抗锯齿切回子像素抗锯齿，于是
  // 任何含文字的区域两张都不一样——反向断言（「此处不该有提示」）因此系统性假红。
  // 实测：最左端左边缘本无左侧渐隐，清 mask 法仍报 667/727 字节不同、maxDelta 254；
  // 而同一方法在无文字的边缘（滑到尽头后的右缘）diffBytes=0，正是「差异来自文字重绘」的指纹。
  // 换成全不透明 mask 后两张都带着合成层，唯一变量才真的只剩「渐隐与否」。
  const opaque = 'linear-gradient(to right, black, black)';
  // 拍第一张前先补齐条件：本来没有 mask 的（窄表、滑到尽头的那一侧）也挂上全不透明 mask，
  // 否则第一张无合成层、第二张有，又把那个变量放回来了。
  await scroller.evaluate((el, mask) => {
    if (globalThis.getComputedStyle(el).maskImage === 'none') {
      el.style.maskImage = mask;
      el.style.webkitMaskImage = mask;
    }
  }, opaque);
  await page.evaluate(() => new Promise(r => globalThis.requestAnimationFrame(r)));
  const painted = await page.screenshot({ clip });

  await scroller.evaluate((el, mask) => {
    // 三种常见提示画法都取消：渐变遮罩换成全不透明、inset 阴影与贴边背景清掉。
    // 改的是这一帧的内联覆盖，不是源码；源码里的提示样式被删时，两张截图会变得一样。
    el.style.maskImage = mask;
    el.style.webkitMaskImage = mask;
    el.style.boxShadow = 'none';
    el.style.backgroundImage = 'none';
  }, opaque);
  await page.evaluate(() => new Promise(r => globalThis.requestAnimationFrame(r)));
  const cleared = await page.screenshot({ clip });

  await scroller.evaluate(el => {
    el.style.maskImage = '';
    el.style.webkitMaskImage = '';
    el.style.boxShadow = '';
    el.style.backgroundImage = '';
  });
  await page.evaluate(() => new Promise(r => globalThis.requestAnimationFrame(r)));
  return !painted.equals(cleared);
}

async function mountNarrowTable(page) {
  await page.evaluate(async () => {
    const { renderMarkdown } = await import('/js/markdown.js');
    const host = globalThis.document.createElement('div');
    host.className = 'msg codex';
    host.id = 'narrow-table-probe';
    host.innerHTML = `<div class="bubble md">${renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |', globalThis)}</div>`;
    globalThis.document.querySelector('#messages').append(host);
    await new Promise(r => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(r)));
  });
  const scroller = page.locator('#narrow-table-probe .table-scroll');
  await expect(scroller).toBeVisible();
  return scroller;
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

  test('宽表格溢出时右侧有横滑提示，滑到尽头消失，窄表没有', async ({ page }) => {
    await sendAndRender(page, 'RICH_MARKDOWN_FIXTURE', p => p.locator('.msg.codex .bubble.md table').last());

    const scroller = page.locator('.msg.codex .bubble.md .table-scroll').last();
    await scroller.scrollIntoViewIfNeeded();

    const overflow = await scroller.evaluate(el => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(overflow.scrollWidth, '这份 fixture 必须真的溢出，否则提示断言会平凡通过')
      .toBeGreaterThan(overflow.clientWidth + 8);

    // class 只用来等 JS 把 overflow 算完；真正的判据是下面的像素对比。
    await expect(scroller).toHaveClass(/can-scroll-right/);
    await expect(scroller).not.toHaveClass(/can-scroll-left/);

    // 判据是像素，不是 class：class 写在 HTML 里用户看不见。把右侧 20px 拍下来，
    // 再把提示用的 mask/阴影清掉拍一张，两张不一样 ⇒ 提示真的画在了那条边上。
    expect(
      await edgeHintPaints(page, scroller, 'right'),
      '表格右侧被截断时，用户应能看出右边还有内容',
    ).toBe(true);
    expect(
      await edgeHintPaints(page, scroller, 'left'),
      '还在最左端时，左侧不应出现「还能往左滑」的假信号',
    ).toBe(false);

    await scroller.evaluate(el => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect(scroller).not.toHaveClass(/can-scroll-right/);
    await expect(scroller).toHaveClass(/can-scroll-left/);
    expect(
      await edgeHintPaints(page, scroller, 'right'),
      '滑到最右端后右侧提示必须消失，否则就是常亮的假信号',
    ).toBe(false);
    expect(
      await edgeHintPaints(page, scroller, 'left'),
      '已经滑走后，左侧应提示左边还有内容',
    ).toBe(true);

    const narrow = await mountNarrowTable(page);
    const narrowOverflow = await narrow.evaluate(el => el.scrollWidth - el.clientWidth);
    expect(narrowOverflow, '探针表必须挤得下，才测得到「没有溢出时不提示」').toBeLessThanOrEqual(1);
    expect(await edgeHintPaints(page, narrow, 'right'), '窄表格右侧不应出现横滑提示').toBe(false);
    expect(await edgeHintPaints(page, narrow, 'left'), '窄表格左侧不应出现横滑提示').toBe(false);
  });

  test('深色模式下宽表格的横滑提示同样成立', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await sendAndRender(page, 'RICH_MARKDOWN_FIXTURE', p => p.locator('.msg.codex .bubble.md table').last());

    const scroller = page.locator('.msg.codex .bubble.md .table-scroll').last();
    await scroller.scrollIntoViewIfNeeded();
    await expect(scroller).toHaveClass(/can-scroll-right/);
    expect(
      await edgeHintPaints(page, scroller, 'right'),
      '深色模式下溢出表格右侧仍应有横滑提示',
    ).toBe(true);
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
