// src/sessions/read-state.js —— 未读位点的跨设备权威存储。
//
// 【它凭什么不算「第二份真相」（架构决定 A2）】
// 「用户在手机上看过某个 thread 到什么时刻」是本网关独有的事实：app-server 的 thread
// 模型里没有「已读」这个概念（thread/list 只给 createdAt / updatedAt / recencyAt，
// 全是 agent 侧的活动时间），也无法从 thread 历史重建——它记录的是**人的浏览行为**，
// 不是 agent 的行为。且它是缓存类：损坏或形状不对一律当作没有，删掉最多让所有会话
// 按新基线重来一次。它不进任何读路径的判定——判定发生在前端 logic/unread.js，
// 本文件只是那份判定的跨设备位点。
//
// 【本模块只做「多客户端增量归并 + 落盘」，不做未读判定】
// 判定在 public/js/logic/unread.js。前后端不得互相 import（边界闸盯着），所以合并语义
// 两侧各写一份——但**方向相反**：这边谁都不权威、逐 key 取较晚；那边远端权威覆盖本地。
// 同向的话客户端的旧 baseline 会往回传染。两份实现之间的唯一连接点是
// tests/invariants/read-state.test.mjs 里那条「两侧判定同义」的断言。
import { readFileSync } from 'node:fs';
import { writeOwnerOnlyFile } from '../../file-security.js';
import { createSerialWriter } from '../shared/serial-writer.js';
import { dataFile } from '../shared/data-dir.js';

const SEEN_CAP = 500;
const MANUAL_CAP = 100;

const isId = value => typeof value === 'string' && value.length > 0;
const num = value => (Number.isFinite(value) ? value : null);

function numericMap(source) {
  const out = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (isId(key) && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function capped(map, cap) {
  const entries = Object.entries(map);
  if (entries.length <= cap) return map;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, cap));
}

export function createReadStateStore({
  file = dataFile('read-state.json'),
  now = Date.now,
  seenCap = SEEN_CAP,
  manualCap = MANUAL_CAP,
} = {}) {
  let state = load();

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return {
        baselineTs: num(parsed?.baselineTs),
        seen: numericMap(parsed?.seen),
        manual: numericMap(parsed?.manual),
      };
    } catch {
      // 损坏、不存在、形状不对 —— 一律当作没有。它是缓存类，让 server 起不来是错的方向。
      return { baselineTs: null, seen: {}, manual: {} };
    }
  }

  const writer = createSerialWriter({
    write: async () => writeOwnerOnlyFile(file, `${JSON.stringify(state, null, 2)}\n`),
  });

  /**
   * 基线只钉一次，且**刻意不在构造时写盘**——让它钉在「第一个客户端真正用到」的时刻，
   * 而不是 server 启动的时刻。两者差着一次可能长达数天的空转。
   */
  function ensureBaseline() {
    if (state.baselineTs === null) {
      state = { ...state, baselineTs: now() };
      writer.schedule();
    }
    return state.baselineTs;
  }

  function snapshot() {
    ensureBaseline();
    return { baselineTs: state.baselineTs, seen: { ...state.seen }, manual: { ...state.manual } };
  }

  return {
    snapshot,

    /** 记「看到此刻」。单调：乱序的旧 ack 不拨回位点。 */
    markRead(sessionId, seenAt = now()) {
      ensureBaseline();
      if (!isId(sessionId) || !Number.isFinite(seenAt)) return snapshot();
      if ((state.seen[sessionId] ?? -Infinity) >= seenAt) return snapshot();

      const seen = capped({ ...state.seen, [sessionId]: seenAt }, seenCap);
      const manual = { ...state.manual };
      // 被这一笔盖过的手动标记要清掉。不清的话形成「本地删了、服务端留着、
      // 下一趟 hydrate 又合并回本地」的长期不对称。
      if ((manual[sessionId] ?? Infinity) <= seenAt) delete manual[sessionId];

      state = { ...state, seen, manual };
      writer.schedule();
      return snapshot();
    },

    /** 设/清手动未读。清的时候**必须同时记 seen**，只删标记会被别的设备复活。 */
    setManual(sessionId, on, at = now()) {
      ensureBaseline();
      if (!isId(sessionId) || !Number.isFinite(at)) return snapshot();

      if (on) {
        state = { ...state, manual: capped({ ...state.manual, [sessionId]: at }, manualCap) };
        writer.schedule();
        return snapshot();
      }

      const manual = { ...state.manual };
      delete manual[sessionId];
      // seen 同样单调——与 markRead 是同一个不变量的两个入口，两侧必须同向。
      const seen = (state.seen[sessionId] ?? -Infinity) >= at
        ? state.seen
        : capped({ ...state.seen, [sessionId]: at }, seenCap);

      state = { ...state, seen, manual };
      writer.schedule();
      return snapshot();
    },

    /** 多客户端增量归并。客户端上报的 baselineTs **不参与**。 */
    applyClientState(incoming) {
      ensureBaseline();
      const seen = { ...state.seen };
      const manual = { ...state.manual };
      for (const [key, value] of Object.entries(numericMap(incoming?.seen))) {
        if (!Object.hasOwn(seen, key) || value > seen[key]) seen[key] = value;
      }
      for (const [key, value] of Object.entries(numericMap(incoming?.manual))) {
        if (!Object.hasOwn(manual, key) || value > manual[key]) manual[key] = value;
      }
      state = { ...state, seen: capped(seen, seenCap), manual: capped(manual, manualCap) };
      writer.schedule();
      return snapshot();
    },

    /**
     * 仍然有效的手动未读 id。供 thread 列表把它们补进来，绕过分页截断。
     * **这里不再截断**——上限已由存储层保证，再截一次等于让「最近标的那一条」静默消失。
     */
    manualUnreadIds() {
      return Object.keys(state.manual).filter(id => state.manual[id] > (state.seen[id] ?? -Infinity));
    },

    /** 退出路径：先 fence 作废在飞的异步写，再同步写权威态。顺序不能反。 */
    flushSaveSync() {
      writer.fence();
      try { writeOwnerOnlyFile(file, `${JSON.stringify(state, null, 2)}\n`); } catch { /* 丢一次位点不致命 */ }
    },

    _writer: writer,   // 仅测试用：等落盘完成
  };
}
