function userContent(item) {
  return (Array.isArray(item.content) ? item.content : [])
    .map(part => {
      if (part?.type === 'text' && typeof part.text === 'string') return part.text.trim();
      if (part?.type === 'mention') return `@${part.name || 'file'}`;
      if (part?.type === 'skill') return `$${part.name || 'skill'}`;
      if (part?.type === 'localImage' || part?.type === 'image') return '[Image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function fileKind(change) {
  return (change?.kind && change.kind.type) || change?.kind || 'modify';
}

// 前端只渲染 slice(-30)，网关没必要把整条 thread 都序列化推给手机。
export const MAX_HISTORY_MESSAGES = 200;

export function normalizeThreadHistoryMessages(thread, { limit = MAX_HISTORY_MESSAGES } = {}) {
  const messages = [];
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      if (item?.type === 'userMessage') {
        const content = userContent(item);
        if (content) messages.push({ role: 'user', content });
        continue;
      }
      if (item?.type === 'agentMessage') {
        const content = typeof item.text === 'string' ? item.text.trim() : '';
        if (content) messages.push({ role: 'assistant', content });
        continue;
      }
      if (item?.type === 'commandExecution') {
        messages.push({
          kind: 'command',
          command: String(item.command || ''),
          output: String(item.aggregatedOutput || ''),
          exitCode: Number.isFinite(item.exitCode) ? item.exitCode : null,
          status: item.status || 'completed',
        });
        continue;
      }
      if (item?.type === 'fileChange') {
        messages.push({
          kind: 'file_change',
          files: (item.changes || []).map(change => ({
            path: change.path || '',
            kind: fileKind(change),
            diff: String(change.diff || ''),
          })),
        });
        continue;
      }
      if (item?.type === 'mcpToolCall') {
        const input = typeof item.arguments === 'string'
          ? item.arguments
          : JSON.stringify(item.arguments || {});
        messages.push({
          kind: 'mcp',
          serverName: item.serverName || 'unknown',
          toolName: item.toolName || 'unknown',
          inputSummary: input,
          outputSummary: item.error?.message || item.result || '',
          ok: !item.error,
        });
        continue;
      }
      if (item?.type === 'webSearch') {
        messages.push({
          kind: 'search',
          query: item.query || '',
          results: (item.results || []).map(result => ({
            title: result.title || '',
            url: result.url || '',
            snippet: result.snippet || '',
          })),
        });
        continue;
      }
      if (item?.type === 'plan') {
        messages.push({
          kind: 'plan',
          plan: Array.isArray(item.plan) ? item.plan : (item.items || []),
        });
        continue;
      }
      if (item?.type === 'reasoning') {
        const text = item.summary || item.text || '';
        if (text) messages.push({ kind: 'reasoning', text, channel: 'summary' });
        continue;
      }
      if (item?.type) {
        messages.push({ kind: 'raw', item });
      }
    }
  }
  return messages.length > limit ? messages.slice(-limit) : messages;
}
