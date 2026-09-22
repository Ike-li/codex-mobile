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

// 拿不到任何 OpenAI 账号数据时，这是「读失败」还是「这种用法本来就没有」？
// 实测 codex 0.153.4 给了区分的依据：自定义 base_url 的第三方网关下 account/read 回
// {account:null, requiresOpenaiAuth:false}；API key 认证回 {account:{type:'apiKey'}}，
// requiresOpenaiAuth 仍是 true。两种都读得到账号本身，只是 usage 与 rateLimits 会被
// -32600 "chatgpt authentication required" 挡掉。说明白比写「暂无」有用。
function emptyStateNote(ack) {
  if (ack?.account?.requiresOpenaiAuth === false) {
    return '第三方网关：模型走自定义 base_url，没有 OpenAI 账号用量';
  }
  if (accountRecord(ack).type === 'apiKey') {
    return 'API key 认证：没有套餐与限额信息';
  }
  return '暂无账号用量';
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
  return parts.join('') || row(emptyStateNote(ack));
}
