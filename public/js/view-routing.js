const GLOBAL_EVENT_TYPES = new Set([
  'device_status',
  'instances',
  'pending_devices',
  'needs_you_changed',
  'status_line',
  'account_login',
  'account_updated',
  'rate_limits',
  'mcp_status',
  'skills_changed',
  'external_agent_config_import',
  'remote_control',
]);

export function eventMatchesTarget(event, target = {}) {
  if (!event || typeof event !== 'object') return false;
  if (event.type === 'thread_status' && event.payload?.scope === 'host') return true;
  if (GLOBAL_EVENT_TYPES.has(event.type)) return true;
  if (!target.instanceId && !target.threadId && event.type === 'init') return true;
  if (target.instanceId && event.instanceId === target.instanceId) return true;
  const eventThreadId = event.sessionId || event.payload?.threadId || null;
  if (target.threadId && eventThreadId) return eventThreadId === target.threadId;
  if (target.instanceId) return false;
  if (target.threadId) return false;
  return !event.instanceId && !event.sessionId;
}

export function withTarget(payload, target = {}) {
  const routed = { ...payload };
  if (target.instanceId) routed.instanceId = target.instanceId;
  if (target.threadId) routed.threadId = target.threadId;
  return routed;
}

/**
 * 出站方向：一条排队中的 outbox 请求是否属于当前视图。
 *
 * threadId 必须先于 instanceId 判断 —— 一个 instance 上可以先后开多个 thread，
 * 反过来先比 instanceId 的话，切到同实例的新 thread 后，旧 thread 的排队消息
 * 会被当成属于当前视图而发出去，落进错误的会话。
 */
export function outboxRequestMatchesView(request, view = {}) {
  const payload = request?.payload || {};
  if (payload.threadId) return payload.threadId === view.threadId;
  if (payload.instanceId) return payload.instanceId === view.instanceId;
  return !view.threadId && !view.instanceId;
}

export function bindThreadFromEvent(target = {}, event = {}) {
  if (target.threadId || !target.instanceId) return target;
  if (event.instanceId !== target.instanceId || !event.sessionId) return target;
  return { ...target, threadId: event.sessionId };
}
