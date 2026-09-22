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
