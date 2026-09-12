// e2e/lib/annotate.js —— 给截图叠编号标注。
//
// 为什么标注要在浏览器里画、而不是事后用图片编辑器加：
// 事后标注的坐标是死的，UI 一挪位置，箭头就指向空白，而且没有任何东西会报错。
// 这里的标注靠选择器定位——选择器失效直接抛，截图 spec 变红。这是 docs/UI_SURFACE.md
// 的编号和界面保持同步的唯一机制。

const STYLE_ID = 'ui-shot-annotation-style';

/**
 * 在页面上给若干元素叠加编号标注。
 *
 * @param {import('@playwright/test').Page} page
 * @param {Array<{sel: string, n?: number|string, place?: 'tr'|'tl'|'br'|'bl'|'center'}>} marks
 *   sel   目标选择器（命中多个时取第一个可见的）
 *   n     显示的编号，对应 UI_SURFACE.md 表格里的「#」列；省略则只描边不加编号，
 *         用于界面上本来就有文字标签的区域（工具面板、斜杠命令面板）
 *   place 编号气泡贴在元素的哪个角，默认右上
 */
export async function annotate(page, marks) {
  const failures = await page.evaluate(
    ({ items, styleId }) => {
      document.querySelectorAll('[data-ui-shot-badge]').forEach(el => el.remove());
      document.querySelectorAll('[data-ui-shot-outlined]').forEach(el => {
        el.style.outline = '';
        el.style.outlineOffset = '';
        el.removeAttribute('data-ui-shot-outlined');
      });

      if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        // 气泡本身不能参与布局，否则给 flex 容器加标注会把被测界面挤变形。
        style.textContent = `
          [data-ui-shot-badge] {
            position: absolute;
            z-index: 2147483647;
            min-width: 20px;
            height: 20px;
            padding: 0 5px;
            box-sizing: border-box;
            border-radius: 10px;
            background: #E5484D;
            color: #fff;
            font: 700 12px/20px ui-sans-serif, system-ui, -apple-system, sans-serif;
            text-align: center;
            pointer-events: none;
            box-shadow: 0 0 0 2px #fff, 0 1px 3px rgba(0,0,0,.4);
          }
        `;
        document.head.appendChild(style);
      }

      const missing = [];
      for (const { sel, n, place = 'tr' } of items) {
        const candidates = [...document.querySelectorAll(sel)];
        // 命中多个时挑第一个有面积的：#send-btn 这类元素在 DOM 里常有隐藏的兄弟节点。
        const el = candidates.find(node => {
          const r = node.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });

        if (!el) {
          missing.push({ sel, n, reason: candidates.length ? '命中了但没有面积' : '选择器没有命中' });
          continue;
        }

        const r = el.getBoundingClientRect();

        // 元素滚出视口时下面的 clamp 会把气泡夹回可见区，结果是编号稳稳地钉在
        // 一个无关元素上、测试还全绿——长 Markdown 那张图就这么把 ①②④ 全糊在了顶栏上。
        // 视口外直接判失败，逼调用方先 scrollIntoViewIfNeeded 或改裁剪区域。
        if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) {
          missing.push({
            sel, n,
            reason: `在视口外（top=${Math.round(r.top)} bottom=${Math.round(r.bottom)}，视口高 ${window.innerHeight}），先滚动到它再标注`,
          });
          continue;
        }

        el.style.outline = '2px solid #E5484D';
        el.style.outlineOffset = '1px';
        el.setAttribute('data-ui-shot-outlined', '');

        // 没给编号就只描边：这块区域的元素自带文字标签，再叠一个气泡纯属遮挡。
        if (n === undefined || n === null) continue;

        const badge = document.createElement('div');
        badge.setAttribute('data-ui-shot-badge', '');
        badge.textContent = String(n);

        const B = 20;
        let x = r.right - B / 2;
        let y = r.top - B / 2;
        if (place === 'tl') { x = r.left - B / 2; y = r.top - B / 2; }
        if (place === 'br') { x = r.right - B / 2; y = r.bottom - B / 2; }
        if (place === 'bl') { x = r.left - B / 2; y = r.bottom - B / 2; }
        if (place === 'center') { x = r.left + r.width / 2 - B / 2; y = r.top + r.height / 2 - B / 2; }

        // 顶栏元素的默认位置会溢出视口顶部，贴边元素同理。夹回可见区，
        // 不然编号被裁掉，图上就是一个没有编号的红框。
        x = Math.max(2, Math.min(x, window.innerWidth - B - 2));
        y = Math.max(2, Math.min(y, window.innerHeight - B - 2));

        badge.style.left = `${x + window.scrollX}px`;
        badge.style.top = `${y + window.scrollY}px`;
        document.body.appendChild(badge);
      }
      return missing;
    },
    { items: marks, styleId: STYLE_ID },
  );

  if (failures.length) {
    const lines = failures.map(f => `  #${f.n}  ${f.sel}  —— ${f.reason}`).join('\n');
    throw new Error(
      `UI_SURFACE.md 的编号标注对不上界面了。以下选择器需要修正，或该条目已经从界面上消失：\n${lines}`,
    );
  }
}

/** 清掉标注，供同一页面接着截下一张不带标注的图。 */
export async function clearAnnotations(page) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-ui-shot-badge]').forEach(el => el.remove());
    document.querySelectorAll('[data-ui-shot-outlined]').forEach(el => {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.removeAttribute('data-ui-shot-outlined');
    });
  });
}
