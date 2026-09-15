export function isDefinitelyUnattempted(request) {
  const attempts = request?.attempts;
  return request?.state === 'pending'
    && (attempts === undefined || attempts === null || attempts === 0)
    && !request?.attemptedGatewayEpoch;
}

export function isProvisionalInstanceOrphan(request, context = {}) {
  const instanceId = request?.payload?.instanceId;
  if (!instanceId || request?.payload?.threadId) return false;
  if (instanceId === context.currentInstanceId) return false;
  if (context.instanceSnapshotReceived !== true) return false;
  const activeInstanceIds = context.activeInstanceIds instanceof Set
    ? context.activeInstanceIds
    : new Set(Array.isArray(context.activeInstanceIds) ? context.activeInstanceIds : []);
  return !activeInstanceIds.has(instanceId);
}

// 一条记录是否已经没有任何自动出路，只能由用户决定重试还是丢弃。
// drain 在 rejected/needs_reconcile 处停下以保序；attempted orphan 既不能 rebind
// （尝试过）、又匹配不上当前视图（目标已失效）、reconcile 的状态白名单也不含
// retryable —— 没有这个出口它会永远留在 outbox 里反复重绘。
export function requiresManualDisposal(request, { orphaned = false } = {}) {
  if (!request) return false;
  if (request.state === 'rejected' || request.state === 'needs_reconcile') return true;
  return orphaned && !isDefinitelyUnattempted(request);
}

// 一条记录该不该出现在当前视图里。
// 前两个条件是原有的：属于当前会话，或是目标已失效的 provisional 孤儿。
// 第三个条件补的是一个会静默吞消息的缺口：记录带 threadId、而那个 thread 已经不在了
// （典型触发是离线发送后服务端重启），此时它既不匹配当前视图，也过不了
// isProvisionalInstanceOrphan 那一关（那个函数见到 threadId 就直接返回 false），
// 于是永远不渲染——用户不知道消息没发出去，也没有任何入口清掉它。
// 已经失败的记录不该被藏起来，哪怕它属于别的会话。
export function shouldSurfaceInOutboxView(request, { matchesView = false, orphaned = false } = {}) {
  if (!request) return false;
  if (matchesView || orphaned) return true;
  // 只捞「已经绑定到某个具体 thread、而那个 thread 不在当前视图」的失败记录。
  // provisional 记录（只有 instanceId）不走这里：它的归属要等实例快照到达才判得出来，
  // 抢先渲染会让它被标成「来自其他会话」，而正确的说法是「原会话目标已失效」。
  if (!request.payload?.threadId) return false;
  return requiresManualDisposal(request, { orphaned: false });
}
