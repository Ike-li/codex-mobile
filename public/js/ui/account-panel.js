import { escapeHtml } from '../util/html-escape.js';
import { formatTokens } from '../session/token-usage.js';

function accountRecord(ack) {
  const raw = ack?.account;
  if (raw?.account && typeof raw.account === 'object') return raw.account;
  if (raw && typeof raw === 'object') return raw;
  return {};
}

function row(title, meta = '') {
  return `<div class="native-list-row">
        <div class="native-row-title">${escapeHtml(title)}</div>
        ${meta ? `<div class="native-row-meta">${escapeHtml(meta)}</div>` : ''}
      </div>`;
}

export function accountPanelHtml(ack) {
  if (!ack?.ok) {
    return row(ack?.error || '无法读取账号用量');
  }
  const account = accountRecord(ack);
  const email = String(account.email || '').trim();
  const plan = String(account.planType || account.plan || '').trim();
  const lifetime = ack.usage?.summary?.lifetimeTokens;
  const limit = ack.rateLimits?.rateLimits || {};
  const limitName = String(limit.limitName || limit.limitId || '').trim();
  const parts = [];
  if (email) parts.push(row('账号', email));
  if (plan) parts.push(row('套餐', plan));
  if (Number.isFinite(lifetime)) parts.push(row('累计用量', formatTokens(lifetime)));
  if (limitName) parts.push(row('限额', limitName));
  return parts.join('') || row('暂无账号用量');
}
