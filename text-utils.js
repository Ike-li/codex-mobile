// text-utils.js —— 共享文本工具函数

/**
 * 截断字符串到指定长度，超长时附加截断标记。
 * @param {string} value
 * @param {number} cap
 * @param {string} [suffix=' …（已截断）']
 * @returns {string}
 */
export function truncate(value, cap, suffix = ' …（已截断）') {
  if (typeof value !== 'string') return '';
  return value.length > cap ? value.slice(0, cap) + suffix : value;
}

// 结构化载荷的限长：字符串按 cap 截断，数组与对象各自最多留 50 项，嵌套最多 depth 层。
// 用在工具卡片上——上游一条 item 可能带着整个 diff 或几万行输出，原样发给浏览器会把
// 消息列表撑爆，而用户真正要看的只是前面那一小段。
export function truncatePayload(value, cap, depth = 4) {
  if (typeof value === 'string') return truncate(value, cap);
  if (Array.isArray(value)) {
    if (depth <= 0) return [];
    return value.slice(0, 50).map(item => truncatePayload(item, cap, depth - 1));
  }
  if (value && typeof value === 'object') {
    if (depth <= 0) return {};
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 50)) {
      out[key] = truncatePayload(child, cap, depth - 1);
    }
    return out;
  }
  return value;
}
