// public/js/logic/unread.js —— 未读判定。纯函数：数据进、数据出，禁碰 DOM / storage / socket。
//
// 【未读是第三条轴，不与另外两条合并】
//   · 「需要你」  —— 阻塞等你，**答过才清**，出口是 thread-status-dot 的 needs-you 态
//   · 服务告警    —— 服务本身出过岔子，时效窗自动退场
//   · 未读        —— 有没有看过新内容，**看过即清**
// 三者的清除条件完全不同。挤进同一个指示器等于让「扫一眼」解除一条本该钉到「答过」
// 的警报，那比没有指示器更糟。
//
// 【manual 的判据是 `manual[id] > seen[id]`，不是「manual 里有没有条目」】
// 这是整个跨设备方案的承重点。旧语义下「标为已读」是**删除条目**，而删除在 LWW 归并里
// 会被别的设备的旧条目复活；改成比时间戳之后，归并退化成纯 max()，幂等、与顺序无关。

export const SEEN_CAP = 500;
export const MANUAL_CAP = 100;

const num = value => (Number.isFinite(value) ? value : null);

/**
 * 这条会话现在该不该亮未读点。
 *
 * 【两条短路的顺序不能反】`manual` 必须排在 `isViewing` 之前。
 * `isViewing` 否定的是**时间判据的可信度**（你正看着它，lastUsedAt 比 seenAt 新不说明
 * 有没看过的东西），它的管辖面到此为止；而 `manual` 是用户显式输入的待办标记，
 * `isViewing` 对它没有管辖权。用户最常标「稍后再看」的时刻，恰恰是正读着这个会话的
 * 那一刻——顺序反了的话那一刻点不亮，而确认框刚刚承诺过这一行会一直显示未读。
 */
export function isSessionUnread({ lastUsedAt, seenAt, baselineTs, isViewing = false, manual = false } = {}) {
  if (manual) return true;
  if (isViewing) return false;

  const last = num(lastUsedAt);
  if (last === null) return false;
  const bar = num(seenAt) ?? num(baselineTs);
  if (bar === null) return false;
  return last > bar;    // 恰好相等不亮：同一时刻的两件事没有先后
}

/** manual 标记此刻是否仍然有效（被一次更晚的「已读」盖过就无效了）。 */
export function isManualUnreadNow(manual = {}, seen = {}, sessionId) {
  const marked = num(manual?.[sessionId]);
  if (marked === null) return false;
  const seenAt = num(seen?.[sessionId]);
  return seenAt === null ? true : marked > seenAt;   // 相等算已读，与上面同向
}

/**
 * 目录头角标的三态。
 *
 * 【脏输入一律按 pending，不按 0】失败方向必须是「说不知道」，不能是「说没有」：
 * 两态实现里 null 和 0 会一起走隐藏分支，于是刷新后用户看到的不是一个加载中的界面，
 * 而是一个明确宣称「都没有未读」的界面。
 */
export function resolveDirUnreadBadge(count) {
  if (!Number.isFinite(count) || count < 0) return { state: 'pending', label: '' };
  if (count === 0) return { state: 'none', label: '' };
  return { state: 'unread', label: `${count} 未读` };
}

// ---------------------------------------------------------------------------
// 状态归并
// ---------------------------------------------------------------------------

/** 只保留「值是有限数」的条目——防手改与旧版本残留把非数字混进比较。 */
function numericMap(source) {
  const out = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (typeof key === 'string' && key && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** 按 ts 保留最新的 cap 条。淘汰最旧的，因为最旧的位点最没有参考价值。 */
function capped(map, cap) {
  const entries = Object.entries(map);
  if (entries.length <= cap) return map;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, cap));
}

export function markSeenEntry(seen, sessionId, now, cap = SEEN_CAP) {
  if (!sessionId || !Number.isFinite(now)) return seen;
  const current = num(seen?.[sessionId]);
  if (current !== null && current >= now) return seen;   // 单调：乱序的旧 ack 不拨回位点
  return capped({ ...numericMap(seen), [sessionId]: now }, cap);
}

export function setManualUnreadEntry(manual, sessionId, on, now, cap = MANUAL_CAP) {
  if (!sessionId) return manual;
  const next = numericMap(manual);
  if (on) {
    if (!Number.isFinite(now)) return manual;
    next[sessionId] = now;
    return capped(next, cap);
  }
  if (!Object.hasOwn(next, sessionId)) return manual;   // 不存在时原样返回，调用方可据此免写盘
  delete next[sessionId];
  return next;
}

/** 逐 key 取较晚的时间戳。幂等、与顺序无关——这正是把 manual 改成比时间戳换来的。 */
export function mergeLatest(a = {}, b = {}) {
  const out = numericMap(a);
  for (const [key, value] of Object.entries(numericMap(b))) {
    if (!Object.hasOwn(out, key) || value > out[key]) out[key] = value;
  }
  return out;
}

/**
 * 把服务端权威态并入本地。
 *
 * 【方向与服务端那侧相反，这不是冗余】服务端做的是**多客户端增量归并**（谁都不权威，
 * 逐 key 取较晚），本地做的是**远端权威覆盖**（baselineTs 无条件取 remote 的）。
 * 两侧同向的话，客户端的旧 baseline 会往回传染。
 *
 * 【remote 无效时原样返回 local，绝不清空】清空的后果是一屏假未读；原样返回只是
 * 功能降级回「每台设备各算各的」，那是个能用的状态。
 */
export function mergeReadState(local = {}, remote, { seenCap = SEEN_CAP, manualCap = MANUAL_CAP } = {}) {
  if (!remote || typeof remote !== 'object' || !Number.isFinite(remote.baselineTs)) return local;
  return {
    baselineTs: remote.baselineTs,
    seen: capped(mergeLatest(local.seen, remote.seen), seenCap),
    manual: capped(mergeLatest(local.manual, remote.manual), manualCap),
  };
}

/**
 * localStorage 原文 → 状态。任何解析失败一律回落，**绝不抛**。
 *
 * 【已有的合法基线必须保留】被 now 覆盖等于每次启动重置基线，于是点永远不亮——
 * 而这个故障看起来就是「未读功能没做」。
 */
export function parseUnreadState(raw, now) {
  const fallback = { baselineTs: now, seen: {}, manual: {} };
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      baselineTs: Number.isFinite(parsed.baselineTs) ? parsed.baselineTs : now,
      seen: numericMap(parsed.seen),
      manual: numericMap(parsed.manual),
    };
  } catch { return fallback; }
}

export function serializeUnreadState(state) {
  return JSON.stringify({
    baselineTs: state?.baselineTs ?? null,
    seen: numericMap(state?.seen),
    manual: numericMap(state?.manual),
  });
}
