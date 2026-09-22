import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { appendOwnerOnlyFile, fixPermissions, mkdirBounded } from '../files/file-security.js';

export function appendJsonlAuditRecord(path, entry, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : 1024 * 1024;
  const maxGenerations = Number.isInteger(options.maxGenerations) && options.maxGenerations > 0
    ? options.maxGenerations
    : 5;
  const line = `${JSON.stringify({ ts: now(), ...entry })}\n`;
  const lineBytes = Buffer.byteLength(line);
  if (lineBytes > maxBytes) throw new Error('Audit record exceeds retention limit');

  const directory = dirname(path);
  mkdirBounded(directory, { mode: 0o700 });
  fixPermissions(directory, true);
  if (existsSync(path) && statSync(path).size + lineBytes > maxBytes) {
    // 代号越大越旧。先丢掉超出保留代数的那一代，再整体后移一位，最后把活动文件挪到 .1。
    // 只留一代的话保留窗口太短，而审计里最有价值的往往是旧记录——入侵通常事后才发现。
    rmSync(`${path}.${maxGenerations}`, { force: true });
    for (let generation = maxGenerations - 1; generation >= 1; generation -= 1) {
      const from = `${path}.${generation}`;
      if (existsSync(from)) renameSync(from, `${path}.${generation + 1}`);
    }
    renameSync(path, `${path}.1`);
    fixPermissions(`${path}.1`, false);
  }
  appendOwnerOnlyFile(path, line);
}
