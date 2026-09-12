// e2e/lib/layout-audit.js —— 布局体检：把「一眼看上去不对劲」变成会变红的断言。
//
// 【为什么需要它】现有的排版用例断言的是结构性契约——没撑破容器、能横向滚动、
// overflow 值对。这些全绿的同时，宽表格的第 4 列可以被挤到 49px 宽（两个汉字），
// 21 个字的中文压成一根竖条、把整行撑到 286px。用户一眼就看出不对，四条断言一条都没红。
//
// 这里补的是另一个维度：不问「会不会崩」，问「读不读得了」。
//
// 【为什么不做 pixel diff】截图对比只能发现「和上次不一样」，发现不了「从第一天起就是错的」。
// 上面那个表格如果现在做基线，49px 会被固化成「正确的样子」，修好了反而变红。
// 这里的判据是绝对的（多窄算窄、多挤算挤），不依赖历史快照。

/** 文本被挤成竖条的判据：高是宽的几倍以上算异常。 */
const SQUEEZE_RATIO = 3;
/** 窄到这个宽度以下才考虑判挤压——宽元素即使很高也只是长段落。 */
const SQUEEZE_MAX_WIDTH = 140;
/** 少于这些字符的元素不判：单个图标字符本来就可能是竖的。 */
const SQUEEZE_MIN_CHARS = 4;

/**
 * 在浏览器里跑一遍布局体检，返回发现的问题。
 *
 * @param {import('@playwright/test').Page} page
 * @param {string|import('@playwright/test').Locator} scope 体检范围。
 *   收 Locator 而不只是选择器字符串：调用方 shotArea 的区域本来就可能是 Locator
 *   （要靠 :has-text() 或 nth 才能定位的元素），只认字符串会在序列化时直接抛。
 * @returns {Promise<{scanned: number, issues: Array<{rule, text, detail}>}>}
 *
 * 【扫描面塌陷怎么判】不是「scanned 必须 > 0」。纯图片、纯图标的区域本来就没有文本叶子，
 * 拿 >0 当判据会让每一张新增的图标截图莫名变红，然后下一个人把这条断言删掉——
 * 门禁死于误报比死于漏报更常见。真正的失明是**有文本却一个都没扫到**，
 * 判据因此是 root.textContent 非空而 scanned === 0，由 auditLayout 自己报成 issue。
 */
export async function auditLayout(page, scope) {
  const isSelector = typeof scope === 'string';
  const label = isSelector ? scope : '(locator)';
  const loc = isSelector ? page.locator(scope).first() : scope.first();

  if (await loc.count() === 0) {
    return { scanned: 0, issues: [{ rule: 'scope', text: label, detail: '体检范围没命中任何元素' }] };
  }

  return loc.evaluate(
    (root, { scopeSel, ratio, maxW, minChars }) => {
      const issues = [];
      let scanned = 0;

      // 必须带上 root 自己：querySelectorAll('*') 只返回后代，而 scope 选择器
      // 经常直接指向承载文字的那个元素（.error-msg 就是），漏掉它会一个都扫不到。
      for (const el of [root, ...root.querySelectorAll('*')]) {
        // 标注气泡是截图脚本自己加的，不是被测界面的一部分。
        if (el.hasAttribute('data-ui-shot-badge')) continue;

        // 判据是「直接挂着文本节点」，不是「没有元素子节点」。后者会漏掉混合内容——
        // <button><span class=icon></span>已归档</button> 的文字直接挂在 button 上，
        // 而 button 有元素子节点，按叶子判会被整个跳过（实测漏掉了归档栏和系统消息两处）。
        //
        // 反过来也必须挡住纯容器：它的高度由子节点累加，对它判高宽比会把每一个
        // 纵向排列的列表都报成「挤压」。只看自有文本正好把两侧都分开。
        const text = [...el.childNodes]
          .filter(node => node.nodeType === 3)
          .map(node => node.textContent)
          .join('')
          .trim();
        if (!text) continue;

        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;

        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
        // 真的想竖排的元素不算缺陷。
        if (cs.writingMode && cs.writingMode.startsWith('vertical')) continue;

        scanned++;

        if (
          text.length >= minChars &&
          r.width < maxW &&
          r.height / r.width > ratio
        ) {
          issues.push({
            rule: 'squeezed-text',
            text: text.slice(0, 30),
            detail: `${Math.round(r.width)}×${Math.round(r.height)}px（高宽比 ${(r.height / r.width).toFixed(1)}），`
              + `${text.length} 个字符被压进 ${Math.round(r.width)}px 宽——正文被挤成了竖条`,
          });
        }
      }

      // 区域里有文字，体检却一个元素都没扫到 —— 那是扫描器失明，不是「全部合规」。
      // 反过来，没有文字的区域（纯图片、纯图标）扫到 0 个是正常的，不报。
      if (scanned === 0 && (root.textContent || '').trim()) {
        issues.push({
          rule: 'scan-collapsed',
          text: scopeSel,
          detail: '区域里有文本内容，体检却没扫到任何文本元素——扫描面塌了，不是「全部合规」',
        });
      }

      return { scanned, issues };
    },
    { scopeSel: label, ratio: SQUEEZE_RATIO, maxW: SQUEEZE_MAX_WIDTH, minChars: SQUEEZE_MIN_CHARS },
  );
}

/** 把体检结果格式化成一条能直接读懂的失败消息。 */
export function formatIssues(scope, issues) {
  const label = typeof scope === 'string' ? scope : '(locator)';
  const lines = issues.map(i => `  [${i.rule}] "${i.text}" —— ${i.detail}`).join('\n');
  return `${label} 里有 ${issues.length} 处布局缺陷：\n${lines}`;
}
