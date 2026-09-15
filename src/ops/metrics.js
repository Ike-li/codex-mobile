// src/ops/metrics.js —— 进程内指标。纯内存，重启清零，不落盘，不主动上报。
//
// 【三张表分开，不合并】
//   counters 答「发生过几次」（只增）
//   gauges   答「最近一次是什么时候 / 当前是多少」（覆盖式）
//   labels   答「是谁 / 为什么」（字符串）
// labels 刻意不并进 gauges：塞字符串进去会让消费方拿到类型不一致的字段，而那种
// 不一致要到序列化之后才显形。
//
// 【getLabel 缺省返回 null 而不是 undefined】undefined 会被 JSON.stringify 整个吃掉，
// 于是前端分不清「这件事没发生过」和「这个字段还没实现」——两者的下一步完全不同。
//
// 【没有上限、没有淘汰】安全性靠「key 集合是编译期固定的常量串」这一条。
// 引入用户可控的 key（比如把路径或设备 id 拼进 key 名）就会变成内存泄漏面，
// 而症状是内存单调增长、要几周才看得出来。加新指标时先确认 key 是写死的。

const counters = new Map();
const gauges = new Map();
const labels = new Map();

export function inc(name, delta = 1) {
  counters.set(name, (counters.get(name) ?? 0) + delta);
}

export function gauge(name, value) {
  if (Number.isFinite(value)) gauges.set(name, value);
}

export function label(name, value) {
  if (typeof value === 'string') labels.set(name, value);
}

export const getCounter = name => counters.get(name) ?? 0;
export const getGauge = name => (gauges.has(name) ? gauges.get(name) : null);
export const getLabel = name => (labels.has(name) ? labels.get(name) : null);

/** 仅测试用：清空全部指标，隔离用例间的累计干扰。 */
export function reset() {
  counters.clear();
  gauges.clear();
  labels.clear();
}

/** 全量快照。供 getMetricsPayload 的白名单映射表读取。 */
export function snapshot() {
  return {
    counters: Object.fromEntries(counters),
    gauges: Object.fromEntries(gauges),
    labels: Object.fromEntries(labels),
  };
}

/**
 * 本模块承认的全部指标名。
 *
 * 【为什么要这张表】`inc()` 记下的计数器不在输出映射里列一行，就永远不会出现在
 * /metrics 里——记了等于没记，且**没有任何报错**。这张表让「记了但没出口」变成
 * 一条会红的断言（test/invariants/metrics-contract.test.mjs）。
 */
export const KNOWN_METRICS = Object.freeze([
  'auth_failures', 'auth_lockouts', 'auth_lockout_last_ts',
  'client_errors', 'client_errors_unapproved', 'client_errors_last_ts',
  'push_success', 'push_failure', 'push_failure_last_ts',
  'needs_you_opened', 'needs_you_resolved',
  'upload_saved', 'upload_rejected',
  'server_started_at',
]);
