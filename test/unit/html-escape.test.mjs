// test/unit/html-escape.test.mjs —— innerHTML 前的转义。
//
// 这个模块是从 app.js 的 IIFE 里搬出来的（I-7 的第一块）。搬之前它不可单测：
// app.js 是一个 4026 行、0 个 export 的闭合 IIFE，唯一能碰到它的是 E2E。
//
// 它是安全关键：app.js 有 52 处 innerHTML 赋值，内容包括 agent 执行任意命令
// 产生的工具输出、文件路径、外部配置。转义漏一处就是 XSS。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { escapeHtml } from '../../public/js/html-escape.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('把能改变 HTML 结构的四个字符转义掉', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;');
});

// & 必须**最先**替换。放到最后的话，前面产生的 &lt; 会被再转义一次变成 &amp;lt;，
// 用户看到的是字面量 "&lt;" 而不是 "<"。
test('& 先于其它字符替换，已转义的实体不会被二次转义', () => {
  assert.equal(escapeHtml('<'), '&lt;', '单个尖括号');
  assert.equal(escapeHtml('&lt;'), '&amp;lt;', '本来就是实体的文本原样转义一次');
  assert.equal(escapeHtml('&<>"'), '&amp;&lt;&gt;&quot;');
});

// ⚠ 单引号**不转义**，所以拼属性必须用双引号。这不是疏漏，是权衡：
// 把 ' 也转掉会改变现有 52 处 innerHTML 的输出字节（"don't" → "don&#39;t"，
// 渲染一样但快照会变）。约定由下面那条绊线守着。
test('单引号不转义——这是有意的，配套约定由绊线守着', () => {
  assert.equal(escapeHtml("don't"), "don't");
});

// 扫源码前先把注释剥掉。第一版没剥，于是命中的是本模块注释里那个「反例示范」——
// 一个只认字面形态的绊线会把讲解它自己的文档当成违规。scripts/mutate.js 的 mask()
// 踩过同一个坑，这里用同样的思路：只保留代码行。
// 局限写明：按行剥，块注释靠 /* */ 跨行匹配；不做真正的词法分析，
// 所以字符串里恰好含 `//` 的行也会被截断——对「找 ='${」这个用途够用。
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => (line.trimStart().startsWith('//') ? '' : line.replace(/\s\/\/.*$/, '')))
    .join('\n');
}

test('前端不得用单引号 HTML 属性包裹插值——escapeHtml 挡不住那种写法', () => {
  const offenders = [];
  for (const name of readdirSync(join(ROOT, 'public/js'))) {
    if (!name.endsWith('.js')) continue;
    // 形如 class='${...}' / id='${...}'：单引号属性里插值。
    const matches = codeOnly(readFileSync(join(ROOT, 'public/js', name), 'utf8')).match(/=\s*'\$\{/g);
    if (matches) offenders.push(`${name}（${matches.length} 处）`);
  }
  assert.deepEqual(offenders, [],
    'escapeHtml 不转义单引号，所以单引号属性里的插值可以闭合属性并注入新属性（如 onerror）。'
    + '改用双引号属性，或者在那一处单独转义 \'');
});

// null / undefined 给空串是对的；但 0 和 false 是**有意义的值**，不该消失。
// app.js 里原来那份用的是 `String(s || '')`，会把 0 吞掉——现在的调用点
// （`escHtml(String(model.exitCode))`）自己包了 String() 所以没咬到人，
// 但下一个写 `escapeHtml(count)` 的人会踩上。
test('只有 null / undefined 变空串，0 与 false 保留', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(0), '0', '退出码 0 是成功，不能渲染成空白');
  assert.equal(escapeHtml(false), 'false');
  assert.equal(escapeHtml(Number.NaN), 'NaN');
});
