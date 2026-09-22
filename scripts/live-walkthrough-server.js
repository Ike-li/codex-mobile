#!/usr/bin/env node
// scripts/live-walkthrough-server.js —— 隔离真机网关：一次性工作区 + 本机已登录的 Codex。
//
// 不接进 playwright.config.js / test:ci。会 spawn 真 `codex app-server`、消耗额度。
// 不碰仓库里正在跑的 :3001，也不把 WORK_DIR 指到本仓。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = process.env.CCM_LIVE_PORT || '3240';
const TEMP_DIR = mkdtempSync(join(tmpdir(), 'ccm-live-'));
const WORK_DIR = join(TEMP_DIR, 'workspace');
const DATA_DIR = join(TEMP_DIR, 'data');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });
writeFileSync(join(DATA_DIR, 'trusted-devices.json'), '[]');
writeFileSync(join(DATA_DIR, 'pending-devices.json'), '[]');
writeFileSync(join(WORK_DIR, 'README.md'), '# live walkthrough workspace\n\nA disposable repo for product walks.\n');
mkdirSync(join(WORK_DIR, 'src'), { recursive: true });
writeFileSync(join(WORK_DIR, 'src', 'hello.js'), 'export function hello(name = "world") {\n  return `hello ${name}`;\n}\n');

try {
  const git = (...args) => execFileSync('git', args, { cwd: WORK_DIR, stdio: 'pipe' });
  git('init', '-q', '-b', 'work');
  git('config', 'user.email', 'walkthrough@example.com');
  git('config', 'user.name', 'walkthrough');
  git('add', 'README.md', 'src/hello.js');
  git('commit', '-qm', 'init');
} catch {
  // 没有 git 时仍可走查，只是工作区面板没有改动分组。
}

process.env.PORT = PORT;
process.env.HOST = '127.0.0.1';
process.env.AUTH_TOKEN = '';
process.env.WORK_DIR = WORK_DIR;
process.env.WORK_DIRS = WORK_DIR;
process.env.CODEX_DATA_DIR = DATA_DIR;
process.env.CODEX_SANDBOX = 'workspace-write';
process.env.CODEX_APPROVAL_POLICY = 'on-request';
process.env.CODEX_ALLOW_INSECURE_REMOTE = '0';
process.env.CODEX_ALLOWED_ORIGINS = '';
if (!process.env.CCM_LIVE_CODEX_BIN) {
  try {
    process.env.CODEX_BIN = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
  } catch {
    process.env.CODEX_BIN = 'codex';
  }
} else {
  process.env.CODEX_BIN = process.env.CCM_LIVE_CODEX_BIN;
}

console.log(`[live-walkthrough] WORK_DIR=${WORK_DIR}`);
console.log(`[live-walkthrough] DATA_DIR=${DATA_DIR}`);
console.log(`[live-walkthrough] URL=http://127.0.0.1:${PORT}`);

await import(join(ROOT, 'server.js'));
