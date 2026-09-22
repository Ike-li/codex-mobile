import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadActionConfirm, threadActionErrorMessage } from '../../public/js/session/thread-actions.js';

test('archive 必须二次确认,且文案指出会话去了哪、怎么找回', () => {
  const confirm = threadActionConfirm('archive');
  assert.ok(confirm, 'archive 静默执行时用户只看到会话凭空消失,无从判断是归档还是丢了');
  assert.match(confirm.title, /归档/);
  // 只说「已归档」不够——用户需要的是回去的路,否则确认框只是把消失预告了一遍。
  assert.match(confirm.body, /显示已归档/);
  // 归档可逆,染成危险色会让它读起来和删除一样重。
  assert.equal(confirm.danger, false);
});

test('delete 保持危险确认,文案明说不可撤销', () => {
  const confirm = threadActionConfirm('delete');
  assert.ok(confirm);
  assert.equal(confirm.danger, true);
  assert.match(confirm.body, /无法从本页撤销/);
  // 旧文案「删除后可从 Codex 历史中消失」语义含糊,读起来像漏字。
  assert.doesNotMatch(confirm.body, /可从 Codex/);
});

// 真实事故:app-server 跑在旧版 codex 上,而 ~/.codex 的状态库已被新版迁移过,
// 删除会话时 app-server 回了一句 SQL 报错,原样糊进了聊天区:
//   failed to delete app-server state for <uuid>: error returned from database:
//   (code: 1) no such table: agent_jobs
// 用户读到的是一行数据库内部术语,既不知道会话删没删,也不知道下一步该干什么。
test('底层状态库对不上时,删除失败要说人话并指向真正的动作', () => {
  const raw = 'failed to delete app-server state for 01a03b08-a9db-7d32-936c-662ba6940fc1: '
    + 'error returned from database: (code: 1) no such table: agent_jobs';
  const msg = threadActionErrorMessage('delete', raw);
  // 先答用户最急的问题:这一下到底删掉了没有。
  assert.match(msg, /未被删除|没有删除/);
  // 再给出最可能奏效的动作——版本对不上,升级 Codex。
  assert.match(msg, /Codex/);
  assert.match(msg, /升级/);
  // 但成因是推断出来的,不是观测到的:no such table 也可能来自库损坏、CODEX_HOME 指错。
  // 文案必须让人看出这是「多半」而不是「就是」,否则真正的原因会被这句话盖住——那正是
  // 下一条测试在防的事,只不过这次发生在它认得出的分支里。
  assert.match(msg, /多半|通常|可能/, '成因是推断,不能写成断言');
  // 原文必须留着:用户要拿它去搜、去提 issue,翻译不能把证据吃掉。
  assert.ok(msg.includes('no such table: agent_jobs'), '原始错误是唯一可上报的证据,不能丢');
});

// 翻译层最容易变质的方向是「什么都想解释一句」。一旦对不认得的错误也套上版本提示,
// 用户会照着去升级 Codex,而真正的原因(比如会话不存在)被这句话盖住,排查反而更远。
test('认不出的错误原样透出,不许套上版本提示', () => {
  const raw = 'thread not found: 019e06c7-e9a1-71f3-94f8-52290c0bf1ea';
  const msg = threadActionErrorMessage('delete', raw);
  assert.equal(msg, raw);
  assert.doesNotMatch(msg, /升级/);
});

// ack 可能压根没带 error 字段(超时、连接断在半路),此时不能渲染出 "undefined"。
test('错误缺失时给出按动作说话的兜底,不渲染 undefined', () => {
  assert.equal(threadActionErrorMessage('delete', undefined), '删除失败');
  assert.equal(threadActionErrorMessage('archive', ''), '归档失败');
  assert.equal(threadActionErrorMessage('unarchive', null), '取消归档失败');
  assert.equal(threadActionErrorMessage('rename', '   '), '重命名失败');
});

test('unarchive 与 rename 不拦确认框', () => {
  // unarchive 是把会话加回来,不是拿走;rename 走的是 prompt,自带输入确认。
  assert.equal(threadActionConfirm('unarchive'), null);
  assert.equal(threadActionConfirm('rename'), null);
  assert.equal(threadActionConfirm(''), null);
  assert.equal(threadActionConfirm(undefined), null);
});
