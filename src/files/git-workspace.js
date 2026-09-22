import { execFile as execFileCb } from 'node:child_process';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { promisify } from 'node:util';

export const MAX_GIT_ENTRIES = 500;
export const MAX_GIT_DIFF_BYTES = 256 * 1024;
const GIT_STATUS_TIMEOUT_MS = 2000;
const GIT_DIFF_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 1 << 20;
const CONFLICT_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

const defaultExecFile = promisify(execFileCb);

function runExecFile(execFile, cmd, args, options) {
  if (typeof execFile !== 'function') {
    return defaultExecFile(cmd, args, options).then(
      result => ({ stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }),
      err => Promise.reject(err),
    );
  }
  return new Promise((resolveP, rejectP) => {
    try {
      execFile(cmd, args, options, (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          rejectP(err);
          return;
        }
        resolveP({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    } catch (err) {
      rejectP(err);
    }
  });
}

function gitExec(cwd, gitArgs, { timeoutMs, maxBuffer, execFile } = {}) {
  return runExecFile(execFile, 'git', ['-C', cwd, ...gitArgs], {
    timeout: timeoutMs ?? GIT_STATUS_TIMEOUT_MS,
    maxBuffer: maxBuffer ?? GIT_MAX_BUFFER,
  });
}

export function parsePorcelainZ(str) {
  if (str == null || str === '') return [];
  const parts = String(str).split('\0').filter(part => part.length > 0);
  const entries = [];
  for (let i = 0; i < parts.length;) {
    const record = parts[i];
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') {
      entries.push({ xy, path, oldPath: parts[i + 1] });
      i += 2;
      continue;
    }
    entries.push({ xy, path });
    i += 1;
  }
  return entries;
}

export function classifyGitEntries(entries) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const conflicted = [];
  for (const entry of entries || []) {
    const xy = entry.xy || '';
    if (xy === '??') {
      untracked.push({ path: entry.path, xy });
      continue;
    }
    if (CONFLICT_XY.has(xy)) {
      conflicted.push({ path: entry.path, xy, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}) });
      continue;
    }
    const X = xy[0] || ' ';
    const Y = xy[1] || ' ';
    if ('MADRC'.includes(X)) staged.push({ path: entry.path, xy, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}) });
    if ('MDT'.includes(Y)) unstaged.push({ path: entry.path, xy, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}) });
  }
  return { staged, unstaged, untracked, conflicted };
}

export function assertSafeRelPath(cwd, relPath) {
  if (typeof relPath !== 'string' || !relPath || !cwd) return null;
  if (isAbsolute(relPath)) return null;
  if (/[\0*?[\]\\:]/.test(relPath)) return null;
  const resolved = resolve(cwd, relPath);
  const rel = relative(cwd, resolved);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const prefix = cwd.endsWith(sep) ? cwd : cwd + sep;
  if (resolved !== cwd && !resolved.startsWith(prefix)) return null;
  return resolved;
}

function isNotGitError(err) {
  const msg = `${err?.message || ''} ${err?.stderr || ''} ${err?.stdout || ''}`.toLowerCase();
  return /not a git repository|outside repository|致命错误|not a git repo/.test(msg);
}

export async function listGitChanges(cwd, opts = {}) {
  if (!cwd || typeof cwd !== 'string') {
    return { ok: false, code: 'bad_cwd', error: '缺少工作目录' };
  }
  const maxEntries = Math.min(opts.maxEntries > 0 ? opts.maxEntries : MAX_GIT_ENTRIES, MAX_GIT_ENTRIES);
  const execFile = opts.execFile;
  const timeoutMs = opts.timeoutMs ?? GIT_STATUS_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? GIT_MAX_BUFFER;

  let branch = null;
  try {
    const current = await gitExec(cwd, ['symbolic-ref', '--short', 'HEAD'], { timeoutMs, maxBuffer, execFile });
    branch = String(current.stdout || '').trim() || null;
  } catch {
    try {
      const rev = await gitExec(cwd, ['rev-parse', '--short', 'HEAD'], { timeoutMs, maxBuffer, execFile });
      branch = String(rev.stdout || '').trim() || null;
    } catch (err) {
      if (isNotGitError(err)) return { ok: false, code: 'not_git', error: '当前目录不是 git 仓库' };
    }
  }

  let statusOut;
  try {
    const status = await gitExec(cwd, ['status', '--porcelain=v1', '-z'], { timeoutMs, maxBuffer, execFile });
    statusOut = status.stdout;
  } catch (err) {
    if (isNotGitError(err)) return { ok: false, code: 'not_git', error: '当前目录不是 git 仓库' };
    return { ok: false, code: 'git_error', error: err.message || 'git status 失败' };
  }

  const all = parsePorcelainZ(statusOut);
  const truncated = all.length > maxEntries;
  const classified = classifyGitEntries(truncated ? all.slice(0, maxEntries) : all);
  return {
    ok: true,
    branch,
    staged: classified.staged,
    unstaged: classified.unstaged,
    untracked: classified.untracked,
    conflicted: classified.conflicted,
    truncated,
  };
}

export async function readGitDiff(cwd, relPath, side, opts = {}) {
  if (!cwd || typeof cwd !== 'string') {
    return { ok: false, code: 'bad_cwd', error: '缺少工作目录' };
  }
  if (side !== 'staged' && side !== 'unstaged') {
    return { ok: false, code: 'bad_side', error: 'side 须为 staged 或 unstaged' };
  }
  if (!assertSafeRelPath(cwd, relPath)) {
    return { ok: false, code: 'bad_path', error: '路径不合法或不在工作目录内' };
  }

  const maxBytes = Math.min(opts.maxBytes > 0 ? opts.maxBytes : MAX_GIT_DIFF_BYTES, MAX_GIT_DIFF_BYTES);
  const timeoutMs = opts.timeoutMs ?? GIT_DIFF_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? Math.max(GIT_MAX_BUFFER, maxBytes + 4096);
  const execFile = opts.execFile;
  const gitArgs = side === 'staged' ? ['diff', '--cached', '--', relPath] : ['diff', '--', relPath];

  let stdout;
  try {
    const result = await gitExec(cwd, gitArgs, { timeoutMs, maxBuffer, execFile });
    stdout = result.stdout || '';
  } catch (err) {
    if (isNotGitError(err)) return { ok: false, code: 'not_git', error: '当前目录不是 git 仓库' };
    return { ok: false, code: 'git_error', error: err.message || 'git diff 失败' };
  }

  const binary = /Binary files .* differ/i.test(stdout) || stdout.includes('\0');
  if (stdout.includes('\0')) {
    return { ok: true, path: relPath, side, patch: '（二进制内容，略）', binary: true, truncated: false, empty: false };
  }

  let patch = stdout;
  let truncated = false;
  if (patch.length > maxBytes) {
    patch = patch.slice(0, maxBytes);
    truncated = true;
  }
  return {
    ok: true,
    path: relPath,
    side,
    patch,
    binary,
    truncated,
    empty: !patch.trim(),
  };
}
