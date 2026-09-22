export function emptyLandingItems({ lastThread = null, changedCount = 0, pendingNeeds = [] } = {}) {
  const items = [];
  // 排在最前：未提交改动回到电脑前照样能看，而 agent 停在审批上只有手机这一条路
  // 能放行。不处理就一直卡着的东西，不该排在「继续上次会话」后面。
  //
  // 带上第一条的 needId/threadId：横幅在落地页上是收起的，这颗按钮就是待审批唯一的
  // 入口，它得自己知道要开哪一条，而不是让调用方再猜一次。
  const pending = Array.isArray(pendingNeeds) ? pendingNeeds : [];
  if (pending.length > 0) {
    items.push({
      action: 'approvals',
      label: `${pending.length} 项等你批准`,
      needId: pending[0]?.needId || '',
      threadId: pending[0]?.target?.threadId || '',
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
