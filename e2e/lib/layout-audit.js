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

/** 高风险操作的触控目标下限（iOS HIG 基线）。 */
const TAP_MIN = 44;

/**
 * 含汉字的文本的字号下限。
 *
 * 为什么只卡汉字、不卡所有文本：同样是 10px，`26ms` 和「延迟」的可读性不是一回事。
 * 汉字的笔画密度远高于拉丁字母——「懂」在 10px 下的一撇一捺不足半个像素，抗锯齿糊成
 * 一团灰；拉丁字母只有 26 个字形、笔画少，10px 仍能靠轮廓辨认。一刀切禁止小字号会把
 * token 计数、延迟毫秒这些纯数字标签一起报掉，那是产品的信息密度选择，不是缺陷。
 *
 * 12px 的依据：Material Design 的 caption 档是 12sp，iOS HIG 最小可用字号 11pt；
 * 中文排版通行的手机端下限也是 12px。低于它的汉字在移动端普遍认为不可读，不是审美问题。
 */
const CJK_MIN_FONT_PX = 12;

/** 汉字区间：基本区 + 扩展 A。标点和全角符号不算——它们没有笔画密度问题。 */
const CJK_PATTERN = /[一-鿿㐀-䶿]/;

/**
 * 高风险操作的语义标记。
 *
 * 只守这一类，不守全部按钮：实测抽屉一屏 26 个可点击元素里 22 个低于 44×44，模式是
 * 全局按钮高度就是 28px——那是产品的视觉密度选择，不是 bug，把它们全报出来只会让
 * 这条规则被整条忽略。而误触「批准执行命令」「Delete」「允许完全访问」的代价和误触
 * 一个普通按钮完全不是一回事，这几类必须够大。
 *
 * 判据从**语义标记**派生，不列举具体元素：新增一个危险按钮只要带上 .native-danger，
 * 就自动被这条守住，不依赖谁记得往清单里补一行。
 */
const HIGH_RISK_SELECTOR = '.native-danger, [data-danger="true"], .approve-btn, .deny-btn';

/**
 * 允许盖住正文的浮层。键是选择器，值必须写明「为什么这个遮挡是有意的」。
 *
 * 默认值落在「遮挡就是缺陷」那一侧——加一条豁免之前先问：真的没有不遮挡的做法吗？
 * 写不出理由的，就是还没想清楚，不该进这个表。
 */
const OVERLAY_ALLOWLIST = new Map([
  ['#jump-to-latest',
    '「有新内容 ↓」浮动提示。它显示的前提就是用户没滚到底部，那一刻可视区底部正显示'
    + '消息流中段的内容——给 #messages 加 padding-bottom 保护的是内容末尾，和这个遮挡'
    + '在不同的坐标系里，实测无效。浮在内容上是这类控件的通行做法（Telegram / 微信同款）：'
    + '代价是盖住一行，换来的是不占常驻空间。'
    + '待改进：它是 left: 50% 居中，正好压在正文中央；移到右侧只会盖住行尾空白。'],
  ['#slash-popup',
    '斜杠命令面板。用户在输入框敲 `/` 才出现，那一刻的任务就是「从列表里挑一个命令」，'
    + '被盖住的空状态建议卡片不属于当前任务；选完或删掉 `/` 面板即消失，内容完整恢复。'
    + '不遮挡的做法是把面板做成推挤布局，但那会让每敲一个字符整个界面上下跳动，'
    + '比遮挡更糟——Slack、Discord、VS Code 的命令面板都是浮层，没有例外。'
    + '补这条豁免的直接原因：字号 scale 抬升后面板变高，第一次盖到了建议卡片的文字。'
    + '遮挡范围仍限于面板自身高度，没有蔓延。'],
]);

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
    (root, { scopeSel, ratio, maxW, minChars, allowOverlays, highRiskSel, tapMin, cjkMin, cjkSrc }) => {
      const cjkRe = new RegExp(cjkSrc);
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
        // 屏读器专用标签的经典形态是 width:1px;height:1px;overflow:hidden —— 它本来
        // 就该看不见，下面每一条规则（被截断、被盖住）对它都成立，全是误报。
        //
        // 判尺寸必须用 boundingRect 而不是 clientWidth/clientHeight：后者对 inline 元素
        // 恒为 0，用它做门槛会把 <code>/<span>/<a> 里的文字整类排除掉——实测把代码块
        // 「复制」按钮压住正文这个真缺陷也一起压没了，漏报比误报更糟。
        if (r.width < 4 || r.height < 4) continue;

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

        // 规则：汉字被排到读不清的字号。
        if (cjkRe.test(text)) {
          const fontPx = parseFloat(cs.fontSize);
          if (fontPx < cjkMin) {
            issues.push({
              rule: 'cjk-font-too-small',
              text: text.slice(0, 30),
              detail: `字号 ${fontPx}px，低于含汉字文本的 ${cjkMin}px 下限`
                + `——汉字笔画密度高，这个尺寸下会糊成灰块`,
            });
          }
        }

        // 规则：文本被截断，而用户不知道自己少看了东西。
        //
        // 三条豁免，每条都是为了让这条规则值得保留：
        //  - overflow-x: auto 也截，但能滑到，信息没丢。
        //  - 横向截断 + text-overflow: ellipsis：用户看得到省略号，知道后面还有。
        //    ellipsis 是合法且常见的设计手段，报它等于禁用它，规则会被学会忽略。
        //  - 15% 的门槛放过一两个字符的边界抖动。
        //
        // 纵向截断不豁免 ellipsis：line-clamp 是整行整行地吃内容，用户只在最后一行
        // 末尾看到一个省略号，损失的量级和「一行末尾少几个字」完全不是一回事——
        // 实测安全档位说明「只有 ls、cat 等信任命令自动执行；其余一律询问」被吃掉半句。
        const clipX = el.scrollWidth > el.clientWidth * 1.15;
        const clipY = el.scrollHeight > el.clientHeight * 1.15;
        const scrollableX = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
        const scrollableY = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
        const badX = clipX && !scrollableX && cs.textOverflow !== 'ellipsis';
        const badY = clipY && !scrollableY;
        if (badX || badY) {
          const axis = badX ? '横向' : '纵向';
          const shown = badX ? el.clientWidth : el.clientHeight;
          const total = badX ? el.scrollWidth : el.scrollHeight;
          issues.push({
            rule: 'clipped-text',
            text: text.slice(0, 30),
            detail: `${axis}只显示了 ${shown}/${total}px（${Math.round(shown / total * 100)}%），`
              + `overflow 是 ${axis === '横向' ? cs.overflowX : cs.overflowY}，剩下的内容用户没有任何办法看到`,
          });
        }
      }

      // 规则：浮动控件盖住正文。
      //
      // 从**遮挡物**出发，不从被遮挡的正文出发。反过来做会漏：正文可能是个 527px 宽的
      // inline 元素（代码块的 <code>，rect 是所有行的并集），按 0.25/0.5/0.75 采样得到的
      // x 正好跳过 32px 宽的「复制」按钮，实测一条都报不出来。浮动控件数量少、尺寸小，
      // 从它采样密度天然够。
      //
      // 「什么算遮挡物」也因此有了准确定义：只有脱离普通流的元素才可能浮在别人上面。
      // #header-context、<summary> 这些普通流元素根本不进候选，之前那两条误报自然消失，
      // 不需要给它们写豁免。
      for (const overlay of [root, ...root.querySelectorAll('*')]) {
        if (overlay.hasAttribute('data-ui-shot-badge')) continue;
        if (allowOverlays.some(sel => overlay.matches(sel))) continue;

        const ov = getComputedStyle(overlay);
        if (ov.position !== 'absolute' && ov.position !== 'fixed' && ov.position !== 'sticky') continue;
        if (ov.visibility === 'hidden' || ov.opacity === '0') continue;
        // 透明的浮层不影响阅读（透明点击热区很常见）。
        if (ov.backgroundColor === 'transparent' || /rgba\(.*,\s*0\)$/.test(ov.backgroundColor)) continue;

        const or = overlay.getBoundingClientRect();
        if (or.width < 4 || or.height < 4) continue;
        // 覆盖大半个视口的是模态遮罩/lightbox，盖住下面是它的本职工作。
        if (or.width * or.height > window.innerWidth * window.innerHeight * 0.5) continue;

        // 在浮层内部采样：中心 + 四角内缩，抓得住只压住一行的小按钮。
        const pts = [
          [or.left + or.width / 2, or.top + or.height / 2],
          [or.left + or.width * 0.2, or.top + or.height * 0.2],
          [or.right - or.width * 0.2, or.top + or.height * 0.2],
          [or.left + or.width * 0.2, or.bottom - or.height * 0.2],
          [or.right - or.width * 0.2, or.bottom - or.height * 0.2],
        ];

        let reported = false;
        for (const [x, y] of pts) {
          if (reported) break;
          if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;

          const stack = document.elementsFromPoint(x, y);
          const idx = stack.indexOf(overlay);
          if (idx < 0) continue;

          for (const below of stack.slice(idx + 1)) {
            // 祖先出现在栈里是必然的（浮层画在它里面），不算它被盖住。
            if (below.contains(overlay)) continue;

            const belowText = [...below.childNodes]
              .filter(node => node.nodeType === 3)
              .map(node => node.textContent)
              .join('')
              .trim();
            if (belowText.length < minChars) continue;

            issues.push({
              rule: 'occluded-text',
              text: belowText.slice(0, 30),
              detail: `被 <${overlay.tagName.toLowerCase()}${overlay.id ? '#' + overlay.id : ''}`
                + `${typeof overlay.className === 'string' && overlay.className ? '.' + overlay.className.split(/\s+/)[0] : ''}>`
                + `（${ov.position} 定位，文字「${(overlay.textContent || '').trim().slice(0, 12)}」）`
                + `盖住，遮挡点 (${Math.round(x)}, ${Math.round(y)})`,
            });
            reported = true;
            break;
          }
        }
      }

      // 规则：高风险操作的触控目标太小。
      for (const el of [root, ...root.querySelectorAll('*')]) {
        if (!el.matches(highRiskSel)) continue;

        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;

        if (r.width < tapMin || r.height < tapMin) {
          issues.push({
            rule: 'tap-target-too-small',
            text: (el.textContent || '').trim().slice(0, 20),
            detail: `${Math.round(r.width)}×${Math.round(r.height)}px，低于高风险操作的 ${tapMin}×${tapMin} 下限`
              + `——误触这个按钮的代价和误触普通按钮不是一回事`,
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
    {
      scopeSel: label,
      ratio: SQUEEZE_RATIO,
      maxW: SQUEEZE_MAX_WIDTH,
      minChars: SQUEEZE_MIN_CHARS,
      allowOverlays: [...OVERLAY_ALLOWLIST.keys()],
      highRiskSel: HIGH_RISK_SELECTOR,
      tapMin: TAP_MIN,
      cjkMin: CJK_MIN_FONT_PX,
      // 正则不能跨 evaluate 边界序列化，传 source 进去在页面里重建。
      cjkSrc: CJK_PATTERN.source,
    },
  );
}

/** 豁免清单，供守护用例检查每条都写了理由。 */
export function overlayAllowlist() {
  return OVERLAY_ALLOWLIST;
}

/** 把体检结果格式化成一条能直接读懂的失败消息。 */
export function formatIssues(scope, issues) {
  const label = typeof scope === 'string' ? scope : '(locator)';
  const lines = issues.map(i => `  [${i.rule}] "${i.text}" —— ${i.detail}`).join('\n');
  return `${label} 里有 ${issues.length} 处布局缺陷：\n${lines}`;
}
