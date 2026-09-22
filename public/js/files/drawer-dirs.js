export const EXPANDED_DIRS_KEY = 'codex_expanded_dirs';

export function loadExpandedDirs(storage, currentCwd) {
  const set = new Set();
  try {
    const saved = JSON.parse(storage?.getItem?.(EXPANDED_DIRS_KEY) || '[]');
    if (Array.isArray(saved)) {
      for (const dir of saved) {
        if (typeof dir === 'string' && dir) set.add(dir);
      }
    }
  } catch { /* ignore bad storage */ }
  if (typeof currentCwd === 'string' && currentCwd) set.add(currentCwd);
  return set;
}

export function persistExpandedDirs(storage, dirs) {
  if (!storage?.setItem) return;
  try {
    storage.setItem(EXPANDED_DIRS_KEY, JSON.stringify([...dirs]));
  } catch { /* ignore quota / private mode */ }
}

export function toggleExpandedDir(dirs, cwd) {
  const set = new Set(dirs);
  if (!cwd) return { set, expanded: false };
  if (set.has(cwd)) set.delete(cwd);
  else set.add(cwd);
  return { set, expanded: set.has(cwd) };
}
