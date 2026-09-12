#!/usr/bin/env node
// scripts/mock-server.js —— E2E 测试用 mock 服务器。
// 设置环境变量并启动 server.js，使用 mock codex app-server。
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MOCK_CODEX = join(HERE, 'mock-codex.sh');
const TEMP_DIR = mkdtempSync(join(tmpdir(), 'ccm-e2e-'));
const DATA_DIR = join(TEMP_DIR, 'data');
mkdirSync(DATA_DIR, { recursive: true });
// Initialize device files so server doesn't error
writeFileSync(join(DATA_DIR, 'trusted-devices.json'), '[]');
writeFileSync(join(DATA_DIR, 'pending-devices.json'), '[]');
writeFileSync(join(TEMP_DIR, 'README.md'), 'e2e workspace\n');
mkdirSync(join(TEMP_DIR, 'src'), { recursive: true });
writeFileSync(join(TEMP_DIR, 'src', 'app.js'), 'export {}\n');

// 把工作区做成一个带三种改动状态的 git 仓库。
//
// 在这之前临时目录不是仓库，工作区面板的「改动」标签渲染出来是一个完全空的框：
// 分支名为空、文件列表为空。workspace-and-composer.spec.js 里那条
// `expect(#git-changes-body).toBeVisible()` 因此在空 body 上也是绿的，验不到分组渲染。
// 分支名固定成 work，截图和断言才不受 init.defaultBranch 的本机配置影响。
try {
  const git = (...args) => execFileSync('git', args, { cwd: TEMP_DIR, stdio: 'pipe' });
  git('init', '-q', '-b', 'work');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'e2e');
  // 服务器自己的运行时产物会落在工作区里，不挡掉就会混进「未跟踪」分组，
  // 出现在 docs/assets/ui 的截图上。
  writeFileSync(join(TEMP_DIR, '.gitignore'), 'data/\n.codex-chat-*.jsonl*\n');
  git('add', 'README.md', 'src/app.js', '.gitignore');
  git('commit', '-qm', 'init');

  writeFileSync(join(TEMP_DIR, 'README.md'), 'e2e workspace\n新增的一行改动\n'); // 未暂存
  writeFileSync(join(TEMP_DIR, 'src', 'staged.js'), 'export const staged = 1\n');
  git('add', 'src/staged.js'); // 已暂存
  writeFileSync(join(TEMP_DIR, 'notes.txt'), '未跟踪的文件\n'); // 未跟踪
} catch {
  // 没有 git 或 git 太老时退回原来的非仓库工作区：其余 E2E 不依赖仓库状态，
  // 只有「改动」标签会退化成空框。
}

// Set environment variables for test mode
process.env.CODEX_BIN = MOCK_CODEX;
process.env.PORT = '3232';
process.env.HOST = '127.0.0.1';
process.env.WORK_DIR = TEMP_DIR;
process.env.WORK_DIRS = TEMP_DIR;
process.env.CODEX_DATA_DIR = DATA_DIR;
process.env.CODEX_SANDBOX = 'read-only';
process.env.CODEX_APPROVAL_POLICY = 'on-request';
process.env.AUTH_TOKEN = ''; // No auth for E2E testing

// Import and run server.js
await import(join(ROOT, 'server.js'));
