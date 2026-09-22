// 本机 UI 偏好：只影响这台设备怎么显示，不进会话配置,也不上行给 Codex。
//
// 和 #session-settings 的分界是**作用域**：那边是 model / permission / effort，
// 换台设备打开同一个会话仍然成立；这边是「我这台手机想不想看到某类消息」,
// 换台设备就该重新选。两者混在一起的直接后果是用户找不到开关——
// 关掉 MCP 刷屏是本机偏好,不该藏在会话设置里。

/**
 * MCP 启动过程中会经过的状态。这几个值之外的一律当故障处理,见下。
 *
 * 实测现场:一次「你是谁」产生 8 条系统消息(4 个 server × starting/ready),
 * 真正的回答被挤出首屏。这些是基础设施的过程状态,正常工作时不需要占用注意力——
 * 想看的话抽屉里本来就有 MCP 状态面板。
 */
const PROGRESS_STATUSES = new Set(['starting', 'ready', 'updated']);

export const DEFAULT_PREFERENCES = Object.freeze({
  // 过程态始终静默。旧版本若写过 mcpStatusMessages:true，读出来也不再灌进对话。
  mcpStatusMessages: false,
});

const STORAGE_KEY = 'codex_ui_prefs';

/**
 * 读出本机偏好。任何一种坏输入都回落到默认值,不抛。
 *
 * 存储里的东西不是我们能控制的:用户可能手改,旧版本可能写过别的结构,跨设备同步
 * 工具也可能塞进半截数据。而 Safari 无痕模式下 localStorage 连读都可能抛
 * SecurityError —— 偏好读不出来是可以接受的降级,整个界面崩掉不是。
 *
 * 只认已声明的键,且类型必须和默认值一致。旧版本留下的多余字段原样带出去的话,
 * 调用方读到的就不再是一个已知形状的对象。
 */
export function readPreferences(storage) {
  let raw = null;
  try {
    raw = storage?.getItem(STORAGE_KEY);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
  if (!raw) return { ...DEFAULT_PREFERENCES };

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...DEFAULT_PREFERENCES };
  }

  const out = { ...DEFAULT_PREFERENCES };
  for (const key of Object.keys(DEFAULT_PREFERENCES)) {
    const value = parsed[key];
    if (typeof value === typeof DEFAULT_PREFERENCES[key]) out[key] = value;
  }
  return out;
}

/** 写一条偏好。未声明的键直接丢弃,存不下就算了 —— 偏好不是必须落盘的数据。 */
export function writePreference(storage, key, value) {
  if (!Object.hasOwn(DEFAULT_PREFERENCES, key)) return;
  const next = { ...readPreferences(storage), [key]: value };
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 无痕模式 / 配额满。丢掉这次写入好过让调用栈炸穿到界面。
  }
}

/**
 * 这条 MCP 状态该不该进消息流。
 *
 * 偏好开关只管噪音,管不到告警 —— 把错误也一起静默掉,用户就再也不知道某个 MCP
 * 起不来了,那比刷屏严重得多。
 *
 * 未知状态归入告警侧:上游随时可能加新状态值,按「不是已知失败词就静默」处理会漏掉
 * 真故障,按「一律报」处理最多是多一条消息。两种错法的代价不对称,选代价小的那边。
 */
export function shouldAnnounceMcpStatus(payload) {
  if (payload?.error) return true;

  const status = payload?.status;
  if (typeof status !== 'string') return true;
  if (!PROGRESS_STATUSES.has(status)) return true;

  return false;
}
