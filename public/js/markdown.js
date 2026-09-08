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
  return enhanceCodeBlocks(sanitized, deps.hljs || globalThis.hljs);
}
