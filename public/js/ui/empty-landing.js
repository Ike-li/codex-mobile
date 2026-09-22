export function emptyLandingItems({ lastThread = null, changedCount = 0 } = {}) {
  const items = [];
  if (lastThread?.id) {
    items.push({
      action: 'continue',
      threadId: lastThread.id,
      cwd: lastThread.cwd || '',
      title: String(lastThread.title || lastThread.preview || '').trim(),
      label: '继续上次会话',
    });
  }
  const changed = Number(changedCount);
  if (Number.isInteger(changed) && changed > 0) {
    items.push({
      action: 'changes',
      label: `查看 ${changed} 项未提交改动`,
    });
  }
  return items;
}
