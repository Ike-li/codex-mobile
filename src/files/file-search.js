import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

export const FILE_SEARCH_LIMIT = 50;
const FILE_SEARCH_MAX_CANDIDATES = 5000;
export const FILE_SEARCH_MAX_DEPTH = 6;
const FILE_SEARCH_CACHE_TTL_MS = 5000;
const FILE_SEARCH_TIMEOUT_MS = 3000;
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.worktrees']);

const defaultExecFile = promisify(execFileCb);
const candidateCache = new Map();

function runExecFile(execFile, cmd, args, options) {
  if (typeof execFile !== 'function') {
    return defaultExecFile(cmd, args, options).then(
      result => ({ stdout: String(result.stdout ?? '') }),
      err => Promise.reject(err),
    );
  }
  return new Promise((resolve, reject) => {
    try {
      execFile(cmd, args, options, (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({ stdout: String(stdout ?? '') });
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function gitLsFiles(cwd, { execFile, timeoutMs = FILE_SEARCH_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await runExecFile(
      execFile,
      'git',
      ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { timeout: timeoutMs, maxBuffer: 1 << 20 },
    );
    return stdout.split('\n').map(line => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

// 用异步 readdir：最坏要走 5000 个候选 × 深度 6，同步版本会把整个事件循环钉住，
// 而这条路径正是非 git 工作区里打 '@' 时走的。
async function walkFiles(root) {
  const out = [];
  const stack = [{ dir: root, rel: '', depth: 0 }];
  while (stack.length && out.length < FILE_SEARCH_MAX_CANDIDATES) {
    const { dir, rel, depth } = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= FILE_SEARCH_MAX_CANDIDATES) break;
      if (entry.name.startsWith('.') || SKIP_DIR_NAMES.has(entry.name)) continue;
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < FILE_SEARCH_MAX_DEPTH) {
          stack.push({ dir: join(dir, entry.name), rel: entryRel, depth: depth + 1 });
        }
      } else if (entry.isFile()) {
        out.push(entryRel);
      }
    }
  }
  return out;
}

export function clearFileSearchCache() {
  candidateCache.clear();
}

async function listCandidatePaths(cwd, opts = {}) {
  if (typeof opts.listCandidates === 'function') return opts.listCandidates(cwd);
  const cached = candidateCache.get(cwd);
  if (cached && Date.now() - cached.ts < FILE_SEARCH_CACHE_TTL_MS) return cached.paths;
  const paths = (await gitLsFiles(cwd, opts)) ?? await walkFiles(cwd);
  candidateCache.set(cwd, { ts: Date.now(), paths });
  return paths;
}

function isSubsequence(needle, haystack) {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

export function matchFiles(paths, query, { limit = FILE_SEARCH_LIMIT } = {}) {
  if (!Array.isArray(paths) || !paths.length) return [];
  const q = String(query || '').trim().toLowerCase();
  const lim = Math.max(1, Number(limit) || FILE_SEARCH_LIMIT);
  if (!q) {
    return paths.map(path => String(path)).filter(Boolean).sort((a, b) => a.localeCompare(b)).slice(0, lim);
  }
  const scored = [];
  for (const raw of paths) {
    const path = String(raw);
    const lower = path.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let tier;
    if (base.includes(q)) tier = 0;
    else if (lower.includes(q)) tier = 1;
    else if (isSubsequence(q, base)) tier = 2;
    else if (isSubsequence(q, lower)) tier = 3;
    else continue;
    scored.push({ path, tier, len: path.length });
  }
  scored.sort((a, b) => a.tier - b.tier || a.len - b.len || a.path.localeCompare(b.path));
  return scored.slice(0, lim).map(item => item.path);
}

export async function searchFiles(cwd, query, opts = {}) {
  if (!cwd || typeof cwd !== 'string') return [];
  const paths = await listCandidatePaths(cwd, opts);
  return matchFiles(paths, query, opts);
}
