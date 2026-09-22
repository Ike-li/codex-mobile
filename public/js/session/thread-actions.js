// 会话行上的动作里,只有「会拿走东西」的那两个需要拦一道确认。
//
// archive 此前是静默执行的:点完会话立刻从列表消失,而列表默认只拉未归档,
// 于是用户看到的就是「会话没了」,和删除毫无区别。它其实可逆,但这份可逆
// 必须先有「显示已归档」入口才成立——所以文案指名那个入口,而不是空口说「可恢复」。
export function threadActionConfirm(action) {
  if (action === 'archive') {
    return {
      title: '归档会话',
      body: '归档后会话会从列表移出。打开抽屉里的「显示已归档」可以找回并取消归档。',
      danger: false,
    };
  }
  if (action === 'delete') {
    return {
      title: '删除会话',
      body: '该会话将从 Codex 历史中移除,且无法从本页撤销。',
      danger: true,
    };
  }
  // unarchive 是把会话加回来,rename 走 prompt 自带输入确认,都不该再拦一道。
  return null;
}

const ACTION_NOUNS = {
  delete: '删除',
  archive: '归档',
  unarchive: '取消归档',
  rename: '重命名',
  compact: '压缩',
  rollback: '回退',
};

// 缺表/缺列最常见的成因是:跑着的 codex 比 ~/.codex 里的状态库旧。状态库是全局共享的,
// 桌面版 Codex 一升级就会把新迁移写进去,旧二进制再去读自己那版才有的表就扑空。
// 但这是推断不是观测——库损坏、CODEX_HOME 指错也会落到同一句报错上,所以文案给的是
// 「多半」加一个最可能奏效的动作,不是断言。重试肯定没用,「稍后再试」那种假出路不给。
// 导出给 scripts/doctor.js 复用：启动前自检和运行时兜底必须认同一个形态，
// 两处各写一份的话，上游改了错误文案就只有一边跟着改。
export const SCHEMA_MISMATCH = /no such (table|column)/i;

// app-server 的错误是给开发者看的:前半截 Rust 的 anyhow 链,后半截 SQLite 原文。
// 原样糊进聊天区,用户读到的是「no such table: agent_jobs」——既答不了「到底删掉了
// 没有」,也给不出下一步。这里只翻译真正认得出的那一类,其余原样透出:猜错比不猜更糟。
//
// 长度是照着 393px 宽的手机视口实测调的:连原文一起是 7 行、151px 高。系统消息气泡是
// text-align:center,居中的多行段落每行行首都错开,读起来偏费力但还可用。别再往翻译里
// 补机制解释——机制写在上面的注释里就够了,用户读了也不会因此多做什么。
export function threadActionErrorMessage(action, rawError) {
  const raw = typeof rawError === 'string' ? rawError.trim() : '';
  const noun = ACTION_NOUNS[action] || '操作';
  if (raw && SCHEMA_MISMATCH.test(raw)) {
    // 先答最急的那个问题。这类失败是原子的,会话不会被删掉一半。
    const intact = action === 'delete' ? '会话未被删除' : '会话保持原样';
    return `${noun}失败,${intact}。多半是运行中的 Codex 比 ~/.codex 里的状态库旧,`
      + `先升级 Codex 再试;仍不行请带原文排查。\n原始错误:${raw}`;
  }
  return raw || `${noun}失败`;
}
