export function diffLineModels(patch) {
  return String(patch || '').split('\n').map(line => {
    if (line.startsWith('+') && !line.startsWith('+++')) return { text: line || ' ', tone: 'add' };
    if (line.startsWith('-') && !line.startsWith('---')) return { text: line || ' ', tone: 'del' };
    if (line.startsWith('@@')) return { text: line || ' ', tone: 'hunk' };
    return { text: line || ' ', tone: 'plain' };
  });
}
