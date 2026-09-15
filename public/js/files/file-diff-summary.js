// 写入前的确认要能看出「改了什么」，不能只问「要覆盖吗」——手机误触代价太高。
//
// 这里不做完整 LCS：文件编辑的实际形态几乎总是「中间某一段变了，头尾原样」，剪掉公共
// 前缀和公共后缀之后剩下的就是变化区间，对这个场景足够，也不会让长文件把确认框撑爆。
// 代价是相邻的多处改动会被并成一段——确认框本来也不适合逐处审阅，那是桌面端的事。

const MAX_HUNK_LINES = 20;

function toLines(text) {
  if (typeof text !== 'string') return [];
  const lines = text.split('\n');
  // 末尾换行不算独立一行，否则每份文件都凭空多出一行空白。
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function summarizeTextChange(before, after) {
  const created = typeof before !== 'string';
  const beforeLines = toLines(before);
  const afterLines = toLines(after);

  let prefix = 0;
  while (prefix < beforeLines.length
    && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]) prefix += 1;

  let suffix = 0;
  while (suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) suffix += 1;

  const removedLines = beforeLines.slice(prefix, beforeLines.length - suffix);
  const addedLines = afterLines.slice(prefix, afterLines.length - suffix);

  const hunk = [
    ...removedLines.map(text => ({ sign: '-', text })),
    ...addedLines.map(text => ({ sign: '+', text })),
  ];

  return {
    created,
    unchanged: removedLines.length === 0 && addedLines.length === 0,
    removed: removedLines.length,
    added: addedLines.length,
    firstChangedLine: prefix + 1,
    hunk: hunk.slice(0, MAX_HUNK_LINES),
    truncated: hunk.length > MAX_HUNK_LINES,
  };
}
