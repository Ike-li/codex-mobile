// e2e/typography-system.spec.js —— 全局排版体系的守护。
//
// 和 markdown-typography.spec.js 的分工：那份守助手回复里 Markdown 元素的结构性契约
// （表格会不会撑破、引用块有没有样式）；这份守的是**整套界面的字号与层级**，判据跨屏幕
// 区域通用，不绑定某一种内容。
//
// coverage: docs/TESTING.md
import { test, expect } from '@playwright/test';

// 显式覆盖 CJK 字形的家族名。判据是「栈里有没有」，不是「解析到了哪个」——
// 见下面用例注释里为什么无头浏览器测不到后者。
const CJK_FAMILIES = [
  'PingFang SC', 'PingFang TC', 'Hiragino Sans GB',       // iOS / macOS
  'Noto Sans SC', 'Noto Sans CJK SC', 'Source Han Sans SC', // Android / Linux
  'HarmonyOS Sans SC', 'MiSans',                            // 国产 Android 定制
  'Microsoft YaHei', '微软雅黑',                             // Windows
];

test.describe('全局排版体系', () => {
  test('字体栈显式覆盖中文，不把 CJK 渲染交给平台兜底', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    const stack = await page.evaluate(
      () => globalThis.getComputedStyle(globalThis.document.body).fontFamily,
    );

    // 为什么判据是「栈里声明了 CJK 家族」而不是「中文实际由某个字体渲染」：
    // 浏览器不暴露「这个字形来自哪个 family」。可用的间接手段是比较中文串在当前栈与在
    // sans-serif 下的测量宽度，但在本机（macOS）两者都解析到 PingFang SC，宽度相同 ——
    // 那个判据在这里恒为「没区别」，测不出任何东西。而这条规则要防的后果恰恰发生在
    // 跑不到的平台上：Android 落到 Roboto（无 CJK 字形）、Windows 落到 Segoe UI（无 CJK
    // 字形），两者都得走 UA 兜底，渲染不受控。所以判据只能落在声明上。
    //
    // ⚠️ 由此而来的限制写在这里，免得读者高估这条断言：它能保证「我们声明了」，
    // 不能保证「目标设备上装了这个字体」。真机渲染只能人眼验。
    const declared = stack.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    const hit = declared.filter(f => CJK_FAMILIES.includes(f));

    expect(
      hit.length,
      `body 字体栈里没有任何显式覆盖 CJK 的家族，中文将由平台兜底决定：${stack}`,
    ).toBeGreaterThan(0);

    // 位置也要对：CJK 家族必须排在通用兜底之前。
    //
    // 「通用兜底」只算 sans-serif / serif，**不算 system-ui**。字体 fallback 是逐字形的，
    // 不是「第一个存在的家族接管全部」：system-ui 在 Android 上解析到 Roboto，而 Roboto
    // 没有中文字形，中文照样继续往后找。只有 sans-serif 例外 —— UA 保证它解析到的字体
    // 总能给出字形，所以排在它后面的 CJK 家族才是真的永远轮不到。
    // （这条判据第一版把 system-ui 也算成兜底，于是把一个正确的栈判成了红。）
    const genericIdx = declared.findIndex(f => f === 'sans-serif' || f === 'serif');
    if (genericIdx >= 0) {
      const firstCjkIdx = declared.findIndex(f => CJK_FAMILIES.includes(f));
      expect(
        firstCjkIdx,
        `CJK 家族排在通用兜底 "${declared[genericIdx]}" 之后就永远轮不到它：${stack}`,
      ).toBeLessThan(genericIdx);
    }
  });

  test('相邻标题级别之间真的分得出来', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#state-label')).toHaveText('idle', { timeout: 10000 });

    // RICH_MARKDOWN_FIXTURE 只有 h1/h2，h3 测不到。自己挂一个齐全的探针，
    // 判据才覆盖到实际会出现在回复里的层级。
    await page.evaluate(async () => {
      const { renderMarkdown } = await import('/js/render/markdown.js');
      const doc = globalThis.document;
      const host = doc.createElement('div');
      host.className = 'msg codex';
      host.id = 'heading-probe';
      host.innerHTML = `<div class="bubble md">${
        renderMarkdown('# 顶层标题\n\n## 次级标题\n\n### 三级标题\n\n正文一行。', globalThis)
      }</div>`;
      doc.querySelector('#messages').append(host);
      await new Promise(r => globalThis.requestAnimationFrame(
        () => globalThis.requestAnimationFrame(r),
      ));
    });

    const levels = await page.locator('#heading-probe .bubble.md').evaluate(el => {
      const win = el.ownerDocument.defaultView;
      const read = sel => {
        const node = el.querySelector(sel);
        const cs = win.getComputedStyle(node);
        return { size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10) };
      };
      return { h1: read('h1'), h2: read('h2'), h3: read('h3'), body: read('p') };
    });

    // 判据不是「h1 比 h2 大」——那 0.5px 也算大。要求的是**至少一个维度真的拉开**。
    //
    // 为什么不能只卡字号比例：中文是等宽方块字，没有 x-height、升部降部这些让人判断
    // 尺寸的辅助线索。同样 13% 的差，在拉丁文里看得出，在一屏汉字里基本察觉不到
    // （改动前 h1 19.5px / h2 17.25px，深色模式截图上两行标题看着一样大）。
    // 字重是第二个维度，拉开它同样解决问题，所以判据写成「二选一」而不是钉死字号。
    const SIZE_RATIO = 1.15;
    const WEIGHT_GAP = 50;
    for (const [hi, lo] of [['h1', 'h2'], ['h2', 'h3'], ['h3', 'body']]) {
      const ratio = levels[hi].size / levels[lo].size;
      const weightGap = levels[hi].weight - levels[lo].weight;
      expect(
        ratio >= SIZE_RATIO || weightGap >= WEIGHT_GAP,
        `${hi} 和 ${lo} 在视觉上分不出来：字号 ${levels[hi].size}px vs ${levels[lo].size}px`
        + `（${((ratio - 1) * 100).toFixed(1)}%，需 ≥${((SIZE_RATIO - 1) * 100).toFixed(0)}%），`
        + `字重 ${levels[hi].weight} vs ${levels[lo].weight}（差 ${weightGap}，需 ≥${WEIGHT_GAP}）`
        + '——两个维度至少要拉开一个',
      ).toBe(true);
    }
  });
});
