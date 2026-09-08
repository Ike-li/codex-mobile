// rpc-log-redaction.js —— 把一帧 RPC 变成一条**可以安全落盘**的日志行。
//
// 从 agent-appserver.js 里搬出来的。它原先是文件底部的一组模块私有函数：不导出、
// 没有任何测试直接调过，只能靠「写一条日志再 grep 里面有没有出现密钥」间接验证。
// 变异跑出来这一族有 31 个存活——而它守的是**唯一把 API key、prompt、绝对路径挡在
// 落盘日志之外的那道闸**。日志文件是 0600 的，但它仍然会进备份、进 issue 附件、进截图。
//
// 三条判据分工不同：
//   SENSITIVE_RPC_KEY_RE  键名像凭证 → 整个值换成 <redacted>，一个字节都不留
//   CONTENT_RPC_KEY_RE    键名是正文 → 只留长度，用户 prompt 与工具输出不落盘
//   其余                  过 sanitize()（抹掉密钥形态）+ sanitizePath()（抹掉家目录）后截断
import { sanitize, sanitizePath } from './sanitizer.js';
import { truncate } from './text-utils.js';

export const RPC_SUMMARY_CAP = 240;
export const SENSITIVE_RPC_KEY_RE = /(token|secret|password|passwd|credential|authorization|api[_-]?key|private[_-]?key|refreshToken|accessToken|chatgptAuthTokens|dataBase64)/i;
export const CONTENT_RPC_KEY_RE = /^(text|input|prompt|content|delta|aggregatedOutput|output|diff|data)$/i;

// 高频增量通知：正文按 CONTENT_RPC_KEY_RE 打码后只剩长度信息，逐帧留档没有意义。
export function isDeltaNotification(frame, method) {
  return frame === 'notification' && typeof method === 'string' && /Delta$|\/delta$/.test(method);
}

export function buildRpcLogEntry(details) {
  const sensitiveMethod = SENSITIVE_RPC_KEY_RE.test(details.method || '');
  const entry = {
    ts: Date.now(),
    direction: details.direction || null,
    frame: details.frame,
    id: details.id ?? null,
    method: details.method || null,
    instanceId: details.instanceId || null,
    sessionId: details.sessionId || null,
  };
  if (details.params !== undefined) entry.params = sensitiveMethod ? '<redacted>' : redactRpcValue(details.params);
  if (details.result !== undefined) entry.result = sensitiveMethod ? '<redacted>' : redactRpcValue(details.result);
  if (details.error !== undefined) entry.error = redactRpcError(details.error);
  return entry;
}

export function redactRpcError(error) {
  if (!error || typeof error !== 'object') return { message: redactRpcString(String(error ?? ''), 'message') };
  const out = {};
  if (error.code !== undefined) out.code = error.code;
  if (error.message !== undefined) out.message = redactRpcString(String(error.message), 'message');
  if (error.data !== undefined) out.data = redactRpcValue(error.data, 'data');
  return out;
}

export function redactRpcValue(value, key = '') {
  if (SENSITIVE_RPC_KEY_RE.test(key)) return '<redacted>';
  if (typeof value === 'string') return redactRpcString(value, key);
  if (Array.isArray(value)) {
    if (CONTENT_RPC_KEY_RE.test(key)) return `<redacted:${value.length} items>`;
    return value.slice(0, 30).map(item => redactRpcValue(item));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, child] of Object.entries(value).slice(0, 40)) {
      out[childKey] = redactRpcValue(child, childKey);
    }
    return out;
  }
  return value;
}

export function redactRpcString(value, key = '') {
  if (CONTENT_RPC_KEY_RE.test(key)) return `<redacted:${value.length} chars>`;
  const pathSafe = key === 'cwd' || key === 'path' || /^([A-Za-z]:\\|\/Users\/|\/home\/|\/tmp\/|\/var\/)/.test(value)
    ? sanitizePath(value)
    : value;
  // 不要在这里对输入切窗口。sanitize 会缩短文本（整块 PEM → ***），窗口既会丢掉
  // 本可进入输出的正文，也会把 -----END----- 这类结束锚切走，让整条 pattern 失配
  // 而把密钥材料原样留下。正则是线性的，全长扫描不是问题。
  return truncate(sanitize(pathSafe), RPC_SUMMARY_CAP);
}
