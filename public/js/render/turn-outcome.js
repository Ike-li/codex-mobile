// R-20：完成页不能只显示模型的自述。「改了哪些文件、跑过哪些验证、哪些失败了」都能从本轮
// 的聚合 diff 与命令执行记录客观导出，不需要相信模型怎么说自己。
//
// 需求稿原本把这条映射到协议的 getConversationSummary，那是记错了——ConversationSummary
// 返回的是会话元数据（preview / cwd / gitInfo / modelProvider），不含改动与验证结果。

export function summarizeTurnOutcome({ diff = '', commands = [] } = {}) {
  const { files, added, removed } = parseUnifiedDiff(diff);

  // 没有退出码就还没有结论，不能计进「跑过的验证」。
  const checks = (Array.isArray(commands) ? commands : [])
    .filter(item => Number.isInteger(item?.exitCode))
    .map(item => ({ command: String(item.command ?? ''), ok: item.exitCode === 0, exitCode: item.exitCode }));
  const failed = checks.filter(item => !item.ok);

  return {
    files,
    added,
    removed,
    hasChanges: files.length > 0,
    checks,
    failed,
    // 一个验证都没跑过时既不是通过也不是失败——报 true 会是谎报。
    allPassed: checks.length === 0 ? null : failed.length === 0,
  };
}

function parseUnifiedDiff(diff) {
  const files = [];
  let added = 0;
  let removed = 0;
  for (const line of String(diff || '').split('\n')) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      files.push(header[2]);
      continue;
    }
    // --- / +++ 是文件头，长得像增删行但不是；先判它们再统计。
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { files, added, removed };
}
