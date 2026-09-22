// html-escape.js —— 把不可信文本变成能放进 innerHTML 的字符串。
//
// 拆出来的原因：这段逻辑此前在 app.js（94 处调用）和 markdown.js 各有一份，
// 而两份**不一样**——app.js 用 `String(s || '')`，markdown.js 用 `String(value ?? '')`。
// 差别是数字 0 和 false 会被前者吞成空串。目前没咬到人，因为传数字的调用点
// （`escHtml(String(model.exitCode))`）自己包了 String()；但那是个等着下一个人踩的坑：
// 写 `escapeHtml(count)` 的人不会想到 0 会消失。
//
// 安全关键：它的输出直接进 innerHTML。app.js 里有 52 处 innerHTML 赋值，
// 内容包括 agent 执行任意命令产生的工具输出。

// ⚠ 转义的是 & < > "，**不含单引号**。所以拼 HTML 属性时必须用双引号：
//     `<div class="${escapeHtml(x)}">`   ✅
//     `<div class='${escapeHtml(x)}'>`   ❌ x 里的单引号能闭合属性并注入新属性
// 这条由 test/html-escape.test.mjs 的绊线守着（禁止单引号属性插值）。
// 不直接把 ' 也转义掉，是因为那会改变现有 52 处 innerHTML 的输出字节
// （"don't" → "don&#39;t"，渲染一样但快照会变），而收益只是省掉上面这条约定。
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
