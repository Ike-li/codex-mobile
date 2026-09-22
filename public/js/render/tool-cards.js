const KIND_LABELS = {
  add: '新增',
  modify: '修改',
  update: '修改',
  delete: '删除',
  rename: '重命名',
};

function kindLabel(kind) {
  return KIND_LABELS[kind] || kind || '修改';
}

export function commandCard({
  command = '',
  output = '',
  exitCode = null,
  status = '',
  running = false,
} = {}) {
  const hasExit = exitCode !== null && exitCode !== undefined && exitCode !== '';
  const numericExit = hasExit ? Number(exitCode) : null;
  const runningNow = running === true && !hasExit;
  return {
    title: '命令',
    command: String(command || ''),
    output: String(output || ''),
    exitCode: Number.isFinite(numericExit) ? numericExit : null,
    status: status || (runningNow ? 'in_progress' : 'completed'),
    running: runningNow,
    ok: Number.isFinite(numericExit) ? numericExit === 0 : null,
  };
}

export function fileChangeCard({ files = [] } = {}) {
  return {
    title: '文件变更',
    files: (Array.isArray(files) ? files : []).map(file => {
      const kind = file?.kind || 'modify';
      const diff = String(file?.diff || '');
      return {
        path: String(file?.path || ''),
        kind,
        kindLabel: kindLabel(kind),
        diff,
        expandable: Boolean(diff),
      };
    }),
  };
}

export { kindLabel };
