// public/js/app/unread-tracker.js —— 未读状态的客户端持有者。
//
// 判定全在 logic/unread.js（纯函数）。这一层只做三件事：读写 localStorage、
// 与服务端同步、把「该不该亮」这个问题答给渲染层。
//
// 【markSeen 与 markEntered 刻意分开】
//   markSeen    只记「看到此刻」，**不动手动标记**，且当前是手动未读态时整个跳过。
//   markEntered 看过 + 手动标记作废，是手动未读**唯一的自动清除点**。
// 合成一个的后果：用户正看着一个会话时长按「标为未读」，离开那一瞬间就被清掉了，
// 而确认框刚刚承诺过这一行会一直显示未读。切后台 / pagehide 用 markSeen 也是同理。
import {
  isSessionUnread, isManualUnreadNow, mergeReadState,
  markSeenEntry, setManualUnreadEntry, parseUnreadState, serializeUnreadState,
} from '/js/session/unread.js';

const STORAGE_KEY = 'codex_unread_v1';

export function createUnreadTracker({
  storage = globalThis.localStorage,
  now = Date.now,
  emit = () => {},
  onChange = () => {},
} = {}) {
  let state = parseUnreadState(readRaw(), now());

  function readRaw() {
    try { return storage?.getItem(STORAGE_KEY) ?? ''; } catch { return ''; }
  }
  function persist() {
    try { storage?.setItem(STORAGE_KEY, serializeUnreadState(state)); } catch { /* 无痕模式等：不落盘也要能用 */ }
  }
  function commit(next) {
    if (next === state) return false;
    state = next;
    persist();
    onChange();
    return true;
  }

  return {
    snapshot: () => ({ ...state }),

    /** 服务端权威态并入本地。remote 无效时原样保留本地，绝不清空。 */
    hydrate(remote) {
      return commit(mergeReadState(state, remote));
    },

    /** 这条会话现在该不该亮点。 */
    isUnread(thread, { viewingId = null } = {}) {
      const id = thread?.id;
      if (!id) return false;
      return isSessionUnread({
        lastUsedAt: thread.lastUsedAt,
        seenAt: state.seen[id],
        baselineTs: state.baselineTs,
        isViewing: id === viewingId,
        manual: isManualUnreadNow(state.manual, state.seen, id),
      });
    },

    /** 离场 / 切后台。不动手动标记；当前就是手动未读态时整个跳过。 */
    markSeen(sessionId) {
      if (!sessionId) return false;
      if (isManualUnreadNow(state.manual, state.seen, sessionId)) return false;
      const at = now();
      const changed = commit({ ...state, seen: markSeenEntry(state.seen, sessionId, at) });
      if (changed) emit('read:mark', { threadId: sessionId, seenAt: at });
      return changed;
    },

    /** 进入会话。手动标记的唯一自动清除点。 */
    markEntered(sessionId) {
      if (!sessionId) return false;
      const at = now();
      const changed = commit({
        ...state,
        seen: markSeenEntry(state.seen, sessionId, at),
        manual: setManualUnreadEntry(state.manual, sessionId, false, at),
      });
      if (changed) emit('read:mark', { threadId: sessionId, seenAt: at });
      return changed;
    },

    /** 长按菜单里的「标为未读 / 标为已读」。 */
    setManualUnread(sessionId, on) {
      if (!sessionId) return false;
      const at = now();
      const manual = setManualUnreadEntry(state.manual, sessionId, on, at);
      // 取消时同步记 seen —— 只删标记会被别的设备的旧条目复活。
      const seen = on ? state.seen : markSeenEntry(state.seen, sessionId, at);
      const changed = commit({ ...state, manual, seen });
      if (changed) emit('read:mark', { threadId: sessionId, manual: on, at });
      return changed;
    },

    isManual(sessionId) {
      return isManualUnreadNow(state.manual, state.seen, sessionId);
    },
  };
}
