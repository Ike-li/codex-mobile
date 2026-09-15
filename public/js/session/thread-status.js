function revision(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function applyThreadStatus(threads, change) {
  if (!Array.isArray(threads) || !change?.threadId || !change?.status) {
    return Array.isArray(threads) ? threads : [];
  }
  const incomingRevision = revision(change.revision);
  return threads.map(thread => {
    if (thread?.id !== change.threadId) return thread;
    const currentRevision = revision(thread.statusRevision);
    if (incomingRevision > 0 && currentRevision > incomingRevision) return thread;
    return {
      ...thread,
      status: change.status,
      statusRevision: incomingRevision > 0 ? incomingRevision : currentRevision,
    };
  });
}

export function mergeThreadList(currentThreads, refreshedThreads) {
  const currentById = new Map(
    (Array.isArray(currentThreads) ? currentThreads : [])
      .filter(thread => thread?.id)
      .map(thread => [thread.id, thread]),
  );
  return (Array.isArray(refreshedThreads) ? refreshedThreads : []).map(thread => {
    const current = currentById.get(thread?.id);
    if (!current || revision(current.statusRevision) <= revision(thread.statusRevision)) {
      return thread;
    }
    return {
      ...thread,
      status: current.status,
      statusRevision: current.statusRevision,
    };
  });
}

// 顶栏标题取自「当前渲染的这份会话列表」,但列表并不总是包含当前会话:切到已归档视图时
// 整份列表都被换掉,刷新回来之前还有一段空窗。返回 null 表示「这份列表答不上来,别动标题」——
// 回落成「新会话」会让顶栏和正文里仍挂着的对话互相打脸。
export function resolveThreadTitle(threads, currentSessionId) {
  if (!currentSessionId) return '新会话';
  const thread = (Array.isArray(threads) ? threads : []).find(item => item?.id === currentSessionId);
  if (!thread) return null;
  return String(thread.title || thread.preview || '').trim() || '新会话';
}

export function threadStatusPresentation(status) {
  if (status?.type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    const waiting = flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput');
    return waiting
      ? { kind: 'needs-you', label: 'needs you', active: true }
      : { kind: 'running', label: 'running', active: true };
  }
  if (status?.type === 'systemError') {
    return { kind: 'error', label: 'error', active: false };
  }
  if (status?.type === 'notLoaded') {
    return { kind: 'not-loaded', label: 'not loaded', active: false };
  }
  return { kind: 'idle', label: 'idle', active: false };
}

// 一张挂着的审批卡为什么不再 pending，原因有三种（取值见 needs-you-registry.js）。
// 此前界面一律写「已在其他设备处理」，但超时和被撤销时这句话是假的——用户会跑去另一台
// 设备找根本不存在的操作记录。未知状态只陈述结果，不编造原因。
export function needResolutionLabel(state) {
  if (state === 'pending') return '';
  if (state === 'resolved') return '已在其他设备处理';
  if (state === 'expired') return '已超时失效';
  if (state === 'revoked') return '已被撤销';
  return '已失效';
}
