// ansi-html.js —— 把带 ANSI 颜色码的工具输出渲染成 HTML。
//
// 从 app.js 的 IIFE 里搬出来的第一块。搬它的理由不是体量（72 行），是它同时满足三条：
//   1. 纯函数——不碰 DOM、window、socket，搬出来零耦合
//   2. 安全关键——输出直接进 innerHTML（app.js:2962），而输入是 agent
//      执行任意命令产生的工具输出
//   3. 在 IIFE 里时**完全无法单元测试**，只能靠 E2E 间接碰到
import { escapeHtml } from './html-escape.js';

// 只认这几个 SGR 码，其余（包括 256 色、真彩色、背景色）一律忽略。
// 忽略是对的：不认识的码不该变成 class 名进到 HTML 里。
const ANSI_CLASSES = {
  1: 'ansi-bold',
  2: 'ansi-dim',
  31: 'ansi-red',
  32: 'ansi-green',
  33: 'ansi-yellow',
  34: 'ansi-blue',
  35: 'ansi-magenta',
  36: 'ansi-cyan',
  90: 'ansi-muted',
};

export function renderAnsi(value) {
  const input = String(value ?? '');
  // ANSI SGR sequences start with the ESC control byte by definition.
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;]*)m/g;
  let html = '';
  let last = 0;
  let open = false;

  for (const match of input.matchAll(re)) {
    // 转义只作用于**转义序列之间的文本**：序列本身被吃掉，不会进入输出。
    html += escapeHtml(input.slice(last, match.index));
    if (open) { html += '</span>'; open = false; }
    const codes = (match[1] || '0').split(';').map(part => Number(part || 0));
    const classes = codes.map(code => ANSI_CLASSES[code]).filter(Boolean);
    if (classes.length) {
      html += `<span class="${classes.join(' ')}">`;
      open = true;
    }
    last = match.index + match[0].length;
  }
  html += escapeHtml(input.slice(last));
  // 收尾补齐：输出被截断在一个还没关闭的颜色段里时，不能留下一个悬空的 <span>——
  // 它会把后面所有 DOM 都吞进这个 span。
  if (open) html += '</span>';
  return html;
}
