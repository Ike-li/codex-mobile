import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, SANITIZE_CONFIG, enhanceCodeBlocks } from '../../public/js/render/markdown.js';

await import('../../public/vendor/marked.min.js');

// 这个文件测的是**接线**，不是消毒本身。下面的 sanitizeWithConfig 是测试自己手写的
// 正则替身，另有两条用 `sanitize: value => value`（原样返回）—— 它们能回答「有没有把
// SANITIZE_CONFIG 传给 DOMPurify」「enhanceCodeBlocks 有没有正确包装代码块」，
// 回答不了「DOMPurify 拦不拦得住某个 payload」。
//
// 真正的消毒边界由 e2e/markdown-sanitization.spec.js 守：真浏览器、真 vendor 库、
// 判据是「脚本执行了没有」。放在这里做不到 —— 仓库里没有 jsdom，vendor 里的
// DOMPurify 是浏览器构建；更要紧的是生产代码里 enhanceCodeBlocks 跑在 sanitize
// **之后**，而在「压根不消毒」的替身下，消毒后注入根本无法被发现。

function sanitizeWithConfig(html, cfg) {
  let out = String(html || '');
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  for (const tag of cfg?.FORBID_TAGS || []) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '');
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), '');
  }
  for (const attr of cfg?.FORBID_ATTR || []) {
    out = out.replace(new RegExp(`\\s${attr}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'gi'), '');
  }
  return out;
}

test('renderMarkdown turns GFM emphasis and code into HTML', () => {
  const html = renderMarkdown('**bold** and `code`', {
    marked: globalThis.marked,
    DOMPurify: { sanitize: value => value },
  });
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
});

test('renderMarkdown 把 SANITIZE_CONFIG 交给 DOMPurify，并把它的输出当最终结果', () => {
  const html = renderMarkdown('hello <script>alert(1)</script>', {
    marked: { parse: raw => raw },
    DOMPurify: {
      sanitize(html, cfg) {
        assert.deepEqual(cfg.FORBID_TAGS, SANITIZE_CONFIG.FORBID_TAGS);
        return sanitizeWithConfig(html, cfg);
      },
    },
  });
  assert.match(html, /hello/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /alert\(1\)/);
});

test('SANITIZE_CONFIG 声明了挡 label/for 的意图（实际拦截由 e2e 验证）', () => {
  const html = renderMarkdown('<label for="send-btn">click</label><button id="send-btn">ok</button>', {
    marked: { parse: raw => raw },
    DOMPurify: {
      sanitize(html, cfg) {
        assert.ok(cfg.FORBID_TAGS.includes('label'));
        assert.ok(cfg.FORBID_ATTR.includes('for'));
        return sanitizeWithConfig(html, cfg);
      },
    },
  });
  assert.doesNotMatch(html, /<label/i);
  assert.doesNotMatch(html, /\sfor=/i);
});

test('renderMarkdown wraps fenced code for copy and highlights when hljs is present', () => {
  const html = renderMarkdown('```js\nconst ok = 1\n```', {
    marked: {
      parse: () => '<pre><code class="language-js">const ok = 1</code></pre>',
    },
    DOMPurify: { sanitize: value => value },
    hljs: {
      highlight(code, opts) {
        assert.equal(opts.language, 'js');
        return { value: '<span class="hljs-keyword">const</span> ok = 1' };
      },
    },
  });
  assert.match(html, /code-block-wrap/);
  assert.match(html, /code-copy-btn/);
  assert.match(html, /hljs-keyword/);
  assert.doesNotMatch(html, /<script/i);
});

// ---- 变异补漏：渲染 agent 输出的那条 XSS 线 ----

// 消毒器或解析器缺一个，就必须整体退回纯转义。这是**降级路径的安全底线**：
// 依赖没加载时宁可让用户看到 markdown 源码，也不能把未消毒的 HTML 塞进 DOM。
// `||` 写成 `&&` 之后，只缺一个依赖时会继续往下走——要么当场 TypeError，
// 要么（缺 DOMPurify 而 marked 在时）把 marked 的原始输出直接渲染出去。
test('marked 或 DOMPurify 缺任何一个都退回纯转义，不渲染未消毒的 HTML', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const marked = { parse: raw => raw };
  const DOMPurify = { sanitize: html => html, addHook: () => {} };

  for (const [label, deps] of [
    ['两个都没有', {}],
    ['只有 marked', { marked }],
    ['只有 DOMPurify', { DOMPurify }],
    ['marked 没有 parse', { marked: {}, DOMPurify }],
    ['DOMPurify 没有 sanitize', { marked, DOMPurify: {} }],
  ]) {
    const out = renderMarkdown(evil, deps);
    assert.equal(out, '&lt;img src=x onerror=alert(1)&gt;', `${label}：必须退回纯转义`);
  }

  // 两个都在时才走正常渲染。
  assert.equal(renderMarkdown('plain', { marked, DOMPurify }), 'plain');
});

// 链接钩子给 <a> 加 target=_blank + rel=noopener noreferrer。
// rel 不是排版，是安全控制：没有 noopener 时新开的页面能通过 window.opener 改写原页面
// （tabnabbing），而这里的链接来自 agent 输出，即不可信内容。
test('链接钩子只作用于 <a>，且 rel 与 target 一起加上', () => {
  const hooks = [];
  const DOMPurify = {
    sanitize: html => html,
    addHook: (name, fn) => hooks.push({ name, fn }),
  };
  renderMarkdown('x', { marked: { parse: raw => raw }, DOMPurify });

  assert.equal(hooks.length, 1, '应当只挂一个钩子');
  assert.equal(hooks[0].name, 'afterSanitizeAttributes', '必须在消毒之后再加属性，否则会被消掉');

  const anchor = { tagName: 'A', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  hooks[0].fn(anchor);
  assert.equal(anchor.attrs.target, '_blank');
  assert.equal(anchor.attrs.rel, 'noopener noreferrer',
    'noopener 挡 tabnabbing，noreferrer 不把当前地址泄给外站——两个都要');

  const div = { tagName: 'DIV', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  hooks[0].fn(div);
  assert.deepEqual(div.attrs, {}, '非链接节点不该被加 target/rel');
});

test('同一个 DOMPurify 只挂一次钩子，重复渲染不会叠加', () => {
  let added = 0;
  const DOMPurify = { sanitize: html => html, addHook: () => { added += 1; } };
  const marked = { parse: raw => raw };
  renderMarkdown('a', { marked, DOMPurify });
  renderMarkdown('b', { marked, DOMPurify });
  renderMarkdown('c', { marked, DOMPurify });
  assert.equal(added, 1, '钩子叠加会让每个链接被处理多次，属性也会被反复写');
});

// gfm 与 breaks 都得开：前者决定表格 / 删除线这些语法认不认，
// 后者决定单个换行是不是渲染成 <br>——agent 的输出大量依赖后者的排版。
test('marked 的 gfm 与 breaks 选项都要开', () => {
  let seen = null;
  const marked = { parse: (raw, options) => { seen = options; return raw; } };
  renderMarkdown('x', { marked, DOMPurify: { sanitize: html => html, addHook: () => {} } });
  assert.deepEqual(seen, { breaks: true, gfm: true });
});

// 语言高亮需要 hljs 与 language 同时具备。少任一个就原样保留已消毒的 body——
// 不能在拿不到语言时把 body 交给 hljs 猜，那会走进未消毒的路径。
test('代码高亮要求 hljs 与语言标记同时具备，否则保留原样', () => {
  const hljs = { highlight: (code, { language }) => ({ value: `<H:${language}>${code}</H>` }) };
  const withLang = '<pre><code class="language-js">let a = 1;</code></pre>';
  const noLang = '<pre><code>let a = 1;</code></pre>';

  assert.match(enhanceCodeBlocks(withLang, hljs), /<H:js>let a = 1;<\/H>/, '两个都有才高亮');
  assert.match(enhanceCodeBlocks(noLang, hljs), />let a = 1;</, '没有语言标记时原样保留');
  assert.match(enhanceCodeBlocks(withLang, undefined), />let a = 1;</, '没有 hljs 时原样保留');
  assert.match(enhanceCodeBlocks(withLang, {}), />let a = 1;</, 'hljs 没有 highlight 方法时同理');

  // hljs 抛异常时回落到已消毒的原文，而不是让整块渲染炸掉。
  const throwing = { highlight: () => { throw new Error('unknown language'); } };
  assert.match(enhanceCodeBlocks(withLang, throwing), />let a = 1;</);
});
