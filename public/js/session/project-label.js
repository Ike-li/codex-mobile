export function projectLabel(cwd) {
  if (typeof cwd !== 'string') return '';
  const trimmed = cwd.trim().replace(/[/\\]+$/, '');
  if (!trimmed) return '';
  const parts = trimmed.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) || trimmed;
}

export function groupThreadsByProject(threads, fallbackCwd = '') {
  const groups = [];
  const index = new Map();
  for (const thread of Array.isArray(threads) ? threads : []) {
    if (!thread?.id) continue;
    const project = projectLabel(thread.cwd || fallbackCwd) || '未分类';
    let group = index.get(project);
    if (!group) {
      group = { project, threads: [] };
      index.set(project, group);
      groups.push(group);
    }
    group.threads.push(thread);
  }
  return groups;
}
