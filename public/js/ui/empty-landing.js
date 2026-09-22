export function emptyLandingItems({ lastThread = null, changedCount = 0, pendingCount = 0 } = {}) {
  const items = [];
  // 排在最前：未提交改动回到电脑前照样能看，而 agent 停在审批上只有手机这一条路
  // 能放行。不处理就一直卡着的东西，不该排在「继续上次会话」后面。
  const pending = Number(pendingCount);
  if (Number.isInteger(pending) && pending > 0) {
    items.push({
      action: 'approvals',
      label: `${pending} 项等你批准`,
    });
  }
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
