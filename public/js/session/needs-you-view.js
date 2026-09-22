// 「需要你」横幅与等待态文案的判据。两者都只依赖入参，不碰 DOM——可见性由调用方
// 测量后作为 inlineNeedIds 传进来。

/**
 * 横幅该列哪些待办。
 *
 * 横幅的唯一职责是把**看不见的**待办拉到眼前：审批发生在别的会话，或者已经滚出视野。
 * 卡片就在视野里时，横幅是同一件事在一屏内说第二遍，还占掉首屏六分之一的高度。
 */
export function bannerNeeds(needs, { inlineNeedIds = [] } = {}) {
  const visible = new Set(inlineNeedIds);
  return (Array.isArray(needs) ? needs : []).filter(need => !visible.has(need?.needId));
}

/** 等待态说的是 agent 此刻在干什么。它在等审批时，就不能说自己在思考。 */
export function waitingLabel({ pendingApprovals = 0 } = {}) {
  return Number(pendingApprovals) > 0 ? '等你批准' : '正在思考';
}
