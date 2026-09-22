import { escapeHtml } from '../util/html-escape.js';

const AUTH_STATUS = {
  loggedIn: '已登录',
  notLoggedIn: '未登录',
  bearerToken: '已登录',
  unsupported: '未接入',
};

function authLabel(status) {
  const raw = String(status || '').trim();
  return AUTH_STATUS[raw] || raw;
}

export function mcpPanelHtml(ack) {
  if (!ack?.ok) {
    return `<div class="native-list-row"><div class="native-row-title">${escapeHtml(ack?.error || '无法读取 MCP 状态')}</div></div>`;
  }
  const rows = (ack.servers || []).map(server => {
    const toolCount = Object.keys(server.tools || {}).length;
    return `<div class="native-list-row">
        <div class="native-row-title">${escapeHtml(server.name)}</div>
        <div class="native-row-meta">${escapeHtml(authLabel(server.authStatus))} · ${toolCount} 个工具</div>
      </div>`;
  }).join('') || '<div class="native-list-row">没有配置 MCP</div>';
  return rows;
}
