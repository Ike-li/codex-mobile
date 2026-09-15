// statusline.js —— web 状态栏：git 状态 + context 用量。
// 纯 JS 组装结构化状态，经 status_line 事件投前端。
import { execFile } from 'node:child_process';
// 协议字段名只在 token-usage.js 里出现一次，前端也 import 同一份——
// 上一版两边各写一遍，statusline 这侧漂到 snake_case 后静默显示了很久的 0。
import { contextFromTokenUsage } from '../../public/js/session/token-usage.js';

// ---- git 状态（per-cwd 短 TTL 缓存）----
const GIT_TTL_MS = 5_000;
const gitCache = new Map(); // cwd -> { at, data|null }
const gitInFlight = new Map(); // cwd -> Promise，避免并发重复 spawn git

function execGit(args, cwd) {
  return new Promise(resolve => {
    try {
      execFile('git', ['-C', cwd, ...args], { timeout: 2_000, maxBuffer: 1 << 20 },
        (err, stdout) => resolve(err ? null : String(stdout).trim()));
    } catch { resolve(null); }
  });
}

// 解析 git diff --shortstat → { insertions, deletions }
function parseShortstat(str) {
  const ins = str && String(str).match(/(\d+) insertion/);
  const del = str && String(str).match(/(\d+) deletion/);
  return { insertions: ins ? parseInt(ins[1], 10) : 0, deletions: del ? parseInt(del[1], 10) : 0 };
}

// 从 git remote url 解析 owner/repo
function parseRepo(url) {
  if (!url) return null;
  const parts = String(url).trim().replace(/\.git$/, '').replace(/\/$/, '').split(/[/:]/).filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : null;
}

// 返回 { branch, changed, ahead, behind, insertions, deletions, repo } 或 null
function gitStatus(cwd) {
  if (!cwd) return Promise.resolve(null);
  const hit = gitCache.get(cwd);
  if (hit && Date.now() - hit.at < GIT_TTL_MS) return Promise.resolve(hit.data);

  // 单飞。缓存写在 5 次 await execGit 之后，所以并发调用会全部 miss 并各自 spawn 5 个
  // git 子进程；网关每 4 秒对每个已批准 socket 推一次状态栏，多设备下放大成进程风暴。
  const inFlight = gitInFlight.get(cwd);
  if (inFlight) return inFlight;

  const pending = collectGitStatus(cwd)
    .then(data => {
      gitCache.set(cwd, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      if (gitInFlight.get(cwd) === pending) gitInFlight.delete(cwd);
    });
  gitInFlight.set(cwd, pending);
  return pending;
}

async function collectGitStatus(cwd) {
  const branch = (await execGit(['symbolic-ref', '--short', 'HEAD'], cwd))
    || (await execGit(['rev-parse', '--short', 'HEAD'], cwd));
  let data = null;
  if (branch) {
    const status = await execGit(['status', '--porcelain'], cwd);
    const changed = status ? status.split('\n').filter(Boolean).length : 0;
    let ahead = 0, behind = 0;
    const lr = await execGit(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], cwd);
    if (lr) { const [a, b] = lr.split(/\s+/).map(n => parseInt(n, 10)); ahead = a || 0; behind = b || 0; }
    const { insertions, deletions } = parseShortstat(await execGit(['diff', '--shortstat', 'HEAD'], cwd));
    const repo = parseRepo(await execGit(['config', '--get', 'remote.origin.url'], cwd));
    data = { branch, changed, ahead, behind, insertions, deletions, repo };
  }
  return data;
}

// ---- 组装 status_line payload ----
export async function buildStatusLine({ agent, cwd, versions }) {
  const p = { ts: Date.now() };
  // session 状态
  if (agent) {
    const sp = typeof agent.statusPayload === 'function' ? agent.statusPayload('status_line') : {};
    p.sessionId = sp.sessionId || null;
    p.state = sp.state || 'idle';
    p.busy = sp.busy || false;
    p.queueLength = sp.queueLength ?? 0;
    p.approvalPolicy = sp.approvalPolicy || null;
    p.sandbox = sp.sandbox || null;
  }
  // work dir
  if (cwd) {
    p.cwd = cwd;
    p.project = cwd.replace(/\/+$/, '').split('/').pop() || cwd;
  }
  // git
  const git = await gitStatus(cwd);
  if (git) p.git = git;
  // context usage
  const ctx = contextFromTokenUsage(agent?.tokenUsage);
  if (ctx) p.ctx = ctx;
  // versions
  if (versions) p.versions = versions;
  return p;
}
