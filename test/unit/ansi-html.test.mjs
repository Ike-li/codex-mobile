// test/unit/ansi-html.test.mjs —— 工具输出的 ANSI 渲染。
//
// 同样是从 app.js 的 IIFE 里搬出来的（I-7 的第一块）。它的输入是 **agent 执行
// 任意命令产生的 stdout**，输出直接进 innerHTML（app.js:2962）——转义漏一处，
// 一条 `echo '<script>…'` 就是 XSS。搬出来之前这些断言一条都写不了。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderAnsi } from '../../public/js/ansi-html.js';

const ESC = '\x1b';

test('没有转义序列时等同于纯转义', () => {
  assert.equal(renderAnsi('plain text'), 'plain text');
  assert.equal(renderAnsi('a & b < c'), 'a &amp; b &lt; c');
});

// 这是这个模块存在的全部风险：输入来自 agent 跑的任意命令。
test('工具输出里的 HTML 一律被转义，不会变成真的标签', () => {
  assert.equal(renderAnsi('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
  // 夹在颜色段里的同样要转义。
  assert.equal(renderAnsi(`${ESC}[31m<img src=x onerror=alert(1)>${ESC}[0m`),
    '<span class="ansi-red">&lt;img src=x onerror=alert(1)&gt;</span>');
  // 长得像转义序列但不是的（含非数字），当普通文本处理并转义。
  assert.equal(renderAnsi(`${ESC}[31;<b>m red`),
    `${ESC}[31;&lt;b&gt;m red`);
});

test('认识的 SGR 码变成对应的 class，reset 关掉它', () => {
  assert.equal(renderAnsi(`${ESC}[32mok${ESC}[0m done`),
    '<span class="ansi-green">ok</span> done');
  assert.equal(renderAnsi(`${ESC}[1;31m危险${ESC}[0m`),
    '<span class="ansi-bold ansi-red">危险</span>');
});

// 不认识的码（256 色、真彩色、背景色）不能变成 class 名进到 HTML 里。
test('不认识的 SGR 码被忽略，不产生 span 也不进入输出', () => {
  assert.equal(renderAnsi(`${ESC}[38;5;196mtext`), 'text', '256 色前景不认识，直接吃掉');
  assert.equal(renderAnsi(`${ESC}[44mtext`), 'text', '背景色不认识');
  assert.equal(renderAnsi(`${ESC}[999mtext`), 'text');
  // 但认识的那部分仍然生效。
  assert.equal(renderAnsi(`${ESC}[999;32mtext`), '<span class="ansi-green">text</span>');
});

// 工具输出经常在中途被截断（命令还在跑、输出被 cap）。留下悬空的 <span>
// 会把它后面的所有 DOM 都吞进这个 span——整块界面的样式跟着串。
test('输出停在未关闭的颜色段里时，收尾补上 </span>', () => {
  assert.equal(renderAnsi(`${ESC}[33m未完`), '<span class="ansi-yellow">未完</span>');
  // 连续切换颜色：前一个必须先关掉再开新的，不能嵌套。
  assert.equal(renderAnsi(`${ESC}[31ma${ESC}[32mb`),
    '<span class="ansi-red">a</span><span class="ansi-green">b</span>');
});

test('空输入与非字符串输入不抛，也不产生标签', () => {
  for (const value of ['', null, undefined]) {
    assert.equal(renderAnsi(value), '', `${String(value)} 应当渲染成空`);
  }
  assert.equal(renderAnsi(0), '0', '数字 0 是有意义的输出，不该消失');
});
