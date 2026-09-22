import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountPanelHtml } from '../../public/js/ui/account-panel.js';

test('读取失败时错误写在面板里', () => {
  const html = accountPanelHtml({ ok: false, error: 'Account read failed' });
  assert.match(html, /Account read failed/);
  assert.doesNotMatch(html, /JSON\.stringify|"account":/);
});

test('成功时用人话展示邮箱、套餐和用量', () => {
  const html = accountPanelHtml({
    ok: true,
    account: { account: { type: 'chatgpt', email: 'u@example.com', planType: 'plus' } },
    usage: { summary: { lifetimeTokens: 123000 } },
    rateLimits: { rateLimits: { limitName: 'Codex' } },
  });
  assert.match(html, /u@example\.com/);
  assert.match(html, /plus/);
  assert.match(html, /123k/);
  assert.match(html, /Codex/);
  assert.doesNotMatch(html, /lifetimeTokens/);
});

test('什么都没有时给出空态，不倒 JSON', () => {
  const html = accountPanelHtml({ ok: true, account: {}, usage: {}, rateLimits: {} });
  assert.match(html, /暂无账号用量/);
  assert.doesNotMatch(html, /\{/);
});

// 下面三条的 fixture 形态来自 codex 0.153.4 实测，不是构造出来的：
//   官方 ChatGPT   → {account:{type:'chatgpt',email,planType}, requiresOpenaiAuth:true}，usage/rateLimits 正常
//   API key        → {account:{type:'apiKey'},                 requiresOpenaiAuth:true}，usage/rateLimits 均 -32600
//   第三方网关     → {account:null,                            requiresOpenaiAuth:false}，同上
// 后两种拿不到任何 OpenAI 账号数据，面板要说清楚是哪一种，而不是含糊的「暂无」。

test('第三方网关：说明没有账号用量的原因，而不是看起来像坏了', () => {
  const html = accountPanelHtml({
    ok: true,
    account: { account: null, requiresOpenaiAuth: false },
    usage: null,
    rateLimits: null,
  });
  assert.match(html, /网关/);
  assert.doesNotMatch(html, /无法读取/, '读到了，只是这种用法没有账号用量');
});

test('API key 认证：同样说明原因，且与网关区分开', () => {
  const html = accountPanelHtml({
    ok: true,
    account: { account: { type: 'apiKey' }, requiresOpenaiAuth: true },
    usage: null,
    rateLimits: null,
  });
  assert.match(html, /API key/i);
  assert.doesNotMatch(html, /网关/, 'requiresOpenaiAuth 仍是 true，不是第三方网关');
});

test('官方账号：附加信息缺失也不影响邮箱与套餐照常显示', () => {
  const html = accountPanelHtml({
    ok: true,
    account: { account: { type: 'chatgpt', email: 'u@example.com', planType: 'plus' }, requiresOpenaiAuth: true },
    usage: null,
    rateLimits: null,
  });
  assert.match(html, /u@example\.com/);
  assert.match(html, /plus/);
});
