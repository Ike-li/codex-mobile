// public/js/token-usage.js —— 上下文占用：协议字段 → 展示格式。
//
// 纯函数、无 DOM 依赖，服务端(statusline.js)和浏览器(app.js)共用同一份。
// 共用是有原因的：上一版 statusline.js 独立写了一遍字段名，用的还是 Anthropic
// Messages API 的 snake_case(input_tokens / cache_creation_input_tokens)，
// 而 app-server 给的是 camelCase。三个字段全部落到 `undefined || 0`，
// 状态栏显示了很久的 0.0k 且不报错。协议字段名只在这个文件里出现一次。
//
// 上下文占用是**状态**不是事件——compact 之后会下降，只能原地更新，
// 不能往消息流里追加。

/**
 * 协议的 ThreadTokenUsage → 展示用 ctx。
 * `last` 是最近一次模型请求的用量快照：每次请求都重发整个历史，所以它约等于
 * 「当前上下文有多大」。`total` 是整个 thread 的累计成本，不是这里要的东西。
 * 字段名对齐 .protocol/stable/v2/TokenUsageBreakdown.ts。
 *
 * 认不出字段时返回 null 而不是全零对象：调用方用 `if (ctx)` 判空，
 * 一个 truthy 的全零对象会把协议漂移伪装成一个可信的 0。
 */
export function contextFromTokenUsage(tokenUsage) {
  const used = tokenUsage?.last?.totalTokens;
  if (!Number.isFinite(used) || used <= 0) return null;
  const window = tokenUsage.modelContextWindow;
  const hasWindow = Number.isFinite(window) && window > 0;
  return {
    contextTokens: used,
    contextWindow: hasWindow ? window : null,
    usedPct: hasWindow ? Math.round((used / window) * 100) : null,
  };
}

export function formatTokens(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  // 整千不写成 "272.0k"
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

export function formatContextMeter(ctx) {
  const used = ctx?.contextTokens;
  if (!Number.isFinite(used) || used <= 0) {
    return { visible: false, label: '', tone: '', pct: null, title: '' };
  }

  const window = ctx.contextWindow;
  const hasWindow = Number.isFinite(window) && window > 0;
  const label = hasWindow
    ? `${formatTokens(used)}/${formatTokens(window)}`
    : formatTokens(used);

  const pct = ctx.usedPct;
  let tone = 'ok';
  if (Number.isFinite(pct)) {
    if (pct >= 90) tone = 'bad';
    else if (pct >= 75) tone = 'warn';
  }
  // 圆环按 pct 填充，具体数字退到 tooltip——抄 ChatGPT 的
  // composer.contextWindowUsageTooltip。没有窗口就画不出比例，只报用了多少。
  const title = hasWindow
    ? `已用 ${formatTokens(used)} 标记，共 ${formatTokens(window)}`
    : `已用 ${formatTokens(used)} 标记`;
  // 环的填充比例必须是合法百分比。长会话的累积用量会超过窗口（实测到过 437%），
  // 那时 tone 已经是 bad、title 也照实报，环再画出个 437% 只是把一个非法值喂给
  // conic-gradient。钳在这里而不是 CSS 里：CSS 拿到的是「画多少」，不该由它判断
  // 数据合不合理。
  const ringPct = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : null;
  return { visible: true, label, tone, pct: ringPct, title };
}
