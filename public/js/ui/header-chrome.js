export function formatRttChip(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    return { visible: false, label: '', tone: '' };
  }
  const label = ms >= 1000 ? `延迟 ${(ms / 1000).toFixed(1)}s` : `延迟 ${Math.round(ms)}ms`;
  let tone = 'ok';
  if (ms < 150) tone = 'good';
  else if (ms < 400) tone = 'ok';
  else if (ms < 1000) tone = 'warn';
  else tone = 'bad';
  return { visible: true, label, tone };
}

export function formatWorkspaceChangeBadge(git) {
  if (!git?.branch) return '';
  const n = git.changed;
  if (!Number.isInteger(n) || n <= 0) return '';
  return n > 99 ? '99+' : String(n);
}
