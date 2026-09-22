import test from 'node:test';
import assert from 'node:assert/strict';

import { mcpPanelHtml } from '../../public/js/ui/mcp-panel.js';

test('读取失败时错误写在面板 HTML 里', () => {
  const html = mcpPanelHtml({
    ok: false,
    error: 'Invalid request: unknown variant `Summary`, expected `full` or `toolsAndAuthOnly`',
  });
  assert.match(html, /native-list-row/);
  assert.match(html, /unknown variant/);
});

test('读取成功时列出服务器名和鉴权态', () => {
  const html = mcpPanelHtml({
    ok: true,
    servers: [{ name: 'github', authStatus: 'notLoggedIn', tools: { search: {} } }],
  });
  assert.match(html, /github/);
  assert.match(html, /未登录/);
  assert.match(html, /1 个工具/);
  assert.doesNotMatch(html, /unknown variant/);
  assert.doesNotMatch(html, /notLoggedIn|tools:/);
});

test('没有服务器时给出空面板，不是错误气泡文案', () => {
  const html = mcpPanelHtml({ ok: true, servers: [] });
  assert.match(html, /没有配置 MCP/);
});
