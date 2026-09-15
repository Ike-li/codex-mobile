// src/ops/client-error-log.js —— 前端错误上报的收敛层。
//
// 前端错误是**不可信输入**：字段可以是任意类型、任意长度，内容里可能带令牌或路径。
// 所以进日志之前三道收敛：形状校验 → 长度钳制 → 脱敏。少任何一道，一次前端崩溃
// 就能把一段带凭据的堆栈原样写进服务端日志。
import { sanitize } from '../../sanitizer.js';

// 长度上限。堆栈本来就长，但一条日志超过这个量级就只是在刷屏——真正有用的信息
// 都在前几帧。
const CAPS = { message: 500, source: 300, stack: 1500 };

const clamp = (value, cap) => (typeof value === 'string' ? value.slice(0, cap) : '');

/**
 * @returns {string} 可以直接写进日志的一行；不是可用的上报则返回空串。
 */
export function formatClientErrorLine(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const message = clamp(payload.message, CAPS.message);
  if (!message) return '';   // 没有 message 的上报没有任何信息量

  const parts = [message];
  const source = clamp(payload.source, CAPS.source);
  if (source) parts.push(`@ ${source}`);
  const stack = clamp(payload.stack, CAPS.stack);
  if (stack) parts.push(stack);

  // 折成一行：多行日志在 journalctl / Console.app 里会被别的进程的输出切碎，
  // 拼不回来。⏎ 保留「这里原本是换行」这个信息。
  return sanitize(parts.join(' | ')).replace(/\r?\n/g, ' ⏎ ');
}

/**
 * per-socket 限流。防的不是攻击，是**错误风暴**：前端一个渲染循环里抛异常，
 * 一秒能上报几千条，把服务端日志冲成只有这一条错误。
 */
export function createSocketErrorLimiter({ max = 10, windowMs = 60_000, now = Date.now } = {}) {
  let windowStart = 0;
  let count = 0;
  return {
    allow() {
      const at = now();
      if (at - windowStart >= windowMs) {
        windowStart = at;
        count = 0;
      }
      count += 1;
      return count <= max;
    },
  };
}
