import { escapeHtml } from './html-escape.js';

export const SANITIZE_CONFIG = {
  FORBID_TAGS: ['label', 'form', 'button', 'select', 'textarea', 'option', 'fieldset', 'legend'],
  FORBID_ATTR: ['style', 'for', 'tabindex', 'accesskey', 'autofocus', 'contenteditable', 'draggable'],
};

const hookedPurifiers = new WeakSet();

function ensureLinkHook(DOMPurify) {
  if (!DOMPurify?.addHook || hookedPurifiers.has(DOMPurify)) return;
  hookedPurifiers.add(DOMPurify);
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

function decodeBasicEntities(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function languageFromClass(className) {
  const match = String(className || '').match(/(?:^|\s)language-([a-z0-9_+-]+)/i);
  return match ? match[1] : '';
}

export function enhanceCodeBlocks(html, hljs) {
  return String(html || '').replace(/<pre><code(?:\s+class="([^"]*)")?>([\s\S]*?)<\/code><\/pre>/gi, (_, className, body) => {
    const language = languageFromClass(className);
    const decoded = decodeBasicEntities(body);
    let highlighted = body;
    if (hljs?.highlight && language) {
      try {
        highlighted = hljs.highlight(decoded, { language }).value;
      } catch {
        highlighted = body;
      }
    }
    const cls = className ? ` class="${className}"` : '';
    return `<div class="code-block-wrap"><button type="button" class="code-copy-btn">复制</button><pre><code${cls}>${highlighted}</code></pre></div>`;
  });
}

/**
 * 给表格包一层滚动容器。
 *
 * 【为什么不能让 table 自己滚】之前的做法是 `display: block; width: max-content;
 * max-width: 100%; overflow-x: auto`，让 <table> 一个元素同时当滚动容器和表格。
 * 结果是 max-width 把**内部表格算法**的可用宽度夹到了阅读栏宽度——表格并不知道
 * 外面能滚，于是老老实实在 361px 里分配 4 列。不可断行的 ASCII 路径 min-content 很大，
 * 抢光空间；中文的 min-content 是一个字，于是「说明」列被压到 49px（两个汉字），
 * 21 个字压成一根竖条、把整行撑到 286px。
 *
 * 拆成两个元素后各管各的：wrapper 负责「不超过阅读栏，超了就滚」，table 取 max-content
 * 宽度、每列都按内容该有的宽度来。
 *
 * 【为什么用正则而不是 DOM】和 enhanceCodeBlocks 同样的位置和同样的约束：只拼固定结构，
 * 不把任何已转义的内容还原成 HTML。GFM 表格不支持嵌套，非贪婪匹配不会配错边界。
 */
export function wrapTables(html) {
  return String(html || '').replace(
    /<table[\s\S]*?<\/table>/gi,
    match => `<div class="table-scroll">${match}</div>`,
  );
}

export function renderMarkdown(raw, deps = globalThis) {
  const marked = deps.marked;
  const DOMPurify = deps.DOMPurify;
  const text = String(raw ?? '');
  if (!marked?.parse || !DOMPurify?.sanitize) return escapeHtml(text);
  ensureLinkHook(DOMPurify);
  // enhanceCodeBlocks 有意跑在 sanitize **之后**。这看着像危险形态（消毒完了又拼 HTML），
  // 但顺序是被设计逼出来的：它注入的包装层里有一个 <button class="code-copy-btn">，而
  // button 在 SANITIZE_CONFIG.FORBID_TAGS 里 —— 先拼后消毒会把复制按钮自己消掉。
  //
  // 安全性因此不能靠顺序，只能靠 enhanceCodeBlocks 自己只拼固定结构、且不把任何已转义的
  // 内容还原成 HTML。这条性质由 e2e/markdown-sanitization.spec.js 在真浏览器里守着，
  // 判据是「脚本执行了没有」；把这两行对调会让那个文件变红。
  const sanitized = DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }), SANITIZE_CONFIG);
  return wrapTables(enhanceCodeBlocks(sanitized, deps.hljs || globalThis.hljs));
}
