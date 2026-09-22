// 消息流准入。每个 agent:event 只能落在四个去向之一：
//   stream — 对话（用户/助手/工具活动/审批/需要人处理的失败）
//   chrome — 顶栏、抽屉、设置、用量环；有自己的表面
//   silent — 丢掉，别的表面已经反映了，或只是过程噪音
//   debug  — 未识别协议；禁止自动把 JSON 插进 #messages
import { shouldAnnounceMcpStatus } from '../ui/ui-preferences.js';

export const DEST = Object.freeze({
  STREAM: 'stream',
  CHROME: 'chrome',
  SILENT: 'silent',
  DEBUG: 'debug',
});

const STREAM_TYPES = new Set([
  'user_message',
  'queued_message',
  'dequeued_message',
  'queue_cleared',
  'text_delta',
  'tool_use',
  'tool_output_delta',
  'tool_result',
  'approval_request',
  'user_input_request',
  'approval_revoked',
  'file_change',
  'plan',
  'reasoning',
  'mcp_use',
  'mcp_result',
  'search',
  'diff',
  'result',
  'error',
]);

const CHROME_TYPES = new Set([
  'device_status',
  'init',
  'status',
  'status_line',
  'instances',
  'thread_status',
  'collaboration_mode',
  'message_receipt',
  'needs_you_changed',
  'account_login',
  'account_updated',
  'usage',
  'pending_devices',
  'compact',
  'rollback',
]);

const SILENT_TYPES = new Set([
  'rate_limits',
  'skills_changed',
  'thread_event',
  'external_agent_config_import',
  'remote_control',
]);

const DEBUG_TYPES = new Set([
  'raw_item',
  'realtime',
]);

const PROTOCOL_LEAK_RE = /unsupported server request|auth token refresh is not supported/i;

export function classifyAgentEvent(event, prefs) {
  const type = event?.type;
  if (typeof type !== 'string' || !type) {
    return { dest: DEST.DEBUG, reason: 'missing-type' };
  }
  if (type === 'mcp_status') {
    return shouldAnnounceMcpStatus(event.payload, prefs)
      ? { dest: DEST.STREAM, reason: 'mcp-alert' }
      : { dest: DEST.SILENT, reason: 'mcp-progress' };
  }
  if (type === 'system') return classifySystemPayload(event.payload);
  if (STREAM_TYPES.has(type)) return { dest: DEST.STREAM, reason: 'conversation' };
  if (CHROME_TYPES.has(type)) return { dest: DEST.CHROME, reason: 'chrome' };
  if (SILENT_TYPES.has(type)) return { dest: DEST.SILENT, reason: 'infra' };
  if (DEBUG_TYPES.has(type)) return { dest: DEST.DEBUG, reason: 'protocol' };
  return { dest: DEST.DEBUG, reason: 'unknown-type' };
}

function classifySystemPayload(payload) {
  const message = String(payload?.message || '');
  if (PROTOCOL_LEAK_RE.test(message)) {
    return { dest: DEST.DEBUG, reason: 'protocol-leak' };
  }
  if (payload?.willRetry === true) return { dest: DEST.SILENT, reason: 'retry-progress' };
  if (payload?.code === -32001) return { dest: DEST.SILENT, reason: 'backpressure' };
  if (payload?.isError) return { dest: DEST.STREAM, reason: 'user-error' };
  return { dest: DEST.STREAM, reason: 'system-note' };
}
