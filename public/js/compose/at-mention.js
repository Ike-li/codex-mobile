const AT_MENTION_PATTERN = /(?:^|\s)[@＠]([\w./-]*)$/;

export function detectAtMentionQuery(textBeforeCursor) {
  const text = typeof textBeforeCursor === 'string' ? textBeforeCursor : '';
  const match = AT_MENTION_PATTERN.exec(text);
  if (!match) return null;
  const atIdx = Math.max(match[0].lastIndexOf('@'), match[0].lastIndexOf('＠'));
  return { query: match[1], matchStart: match.index + atIdx };
}

export function applyAtMentionPick(fullText, { matchStart, cursorPos, path } = {}) {
  const text = typeof fullText === 'string' ? fullText : '';
  const start = Number(matchStart) || 0;
  const cursor = Number(cursorPos) || 0;
  const before = text.slice(0, start);
  const after = text.slice(cursor);
  const inserted = /^\s/.test(after) ? String(path || '') : `${path} `;
  return { text: before + inserted + after, cursorPos: (before + inserted).length };
}

export function mentionPartFromSearchHit(relPath, cwd) {
  const relative = String(relPath || '').replace(/^\/+/, '');
  const name = relative.split('/').filter(Boolean).pop() || 'file';
  const root = String(cwd || '').replace(/\/+$/, '');
  return {
    kind: 'mention',
    name,
    path: root ? `${root}/${relative}` : relative,
  };
}
