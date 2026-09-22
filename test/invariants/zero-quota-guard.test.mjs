// test/invariants/zero-quota-guard.test.mjs —— 守护「日常回归不消耗模型额度」这条项目规则。
// 守护：QUOTA-01
//
// AGENTS.md 写着「默认不要调用真实 Codex CLI 或消耗模型额度；E2E 日常回归必须走 mock server」。
// 这条规则此前没有任何机制守护 —— 它只是一句文档，违反了不会有任何东西变红，
// 代价却是静默烧额度。这里补三道：mock 后端探测必须挂在 globalSetup 上、
// E2E webServer 必须指向 mock 脚本、mock 脚本必须真的把 CODEX_BIN 指向假二进制。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = relativePath => readFileSync(join(ROOT, relativePath), 'utf8');

test('Playwright 在跑用例前先探测后端是不是 mock', () => {
  const config = read('playwright.config.js');
  assert.match(
    config,
    /globalSetup:\s*'\.\/e2e\/assert-mock-backend\.js'/,
    'globalSetup 被摘掉后，reuseExistingServer 复用真 CLI 实例就没有任何拦截',
  );
});

test('E2E 的 webServer 起的是 mock 脚本', () => {
  const config = read('playwright.config.js');
  assert.match(
    config,
    /command:\s*'node scripts\/mock-server\.js'/,
    'webServer.command 必须是 mock 入口，直接起 server.js 会接上宿主机真实的 CODEX_BIN',
  );
});

// 这一条守的是「单测不依赖宿主机装了 codex」。字面量 'codex' 要靠 PATH 解析，
// 缺失时进程会**静默消失** —— 没有 TAP 输出、没有 not ok、没有错误，只剩一份没有
// 汇总行的日志。CI 的 Node 22 腿因此连续失败五次以上：它跳过 Install pinned Codex，
// 而开发机装了 codex 所以永远复现不出来。用绝对路径（process.execPath）就没有这层依赖。
test('测试不靠宿主机 PATH 解析 codex 二进制', () => {
  const offenders = [];
  // 递归：测试按执行槽分在 test/{unit,invariants,integration,infra}/ 下。扁平扫描在分层
  // 之后会扫到 0 个文件，而「扫到 0 个」与「一个违规都没有」在断言上完全一样——
  // 下面的地板断言就是为了让这两者能被区分开。
  const walk = (dir, prefix) => readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const rel = join(prefix, entry.name);
      if (entry.isDirectory()) return walk(join(dir, entry.name), rel);
      return entry.name.endsWith('.test.mjs') ? [rel] : [];
    });
  const files = walk(join(ROOT, 'test'), 'test');
  assert.ok(files.length >= 50, `测试文件扫描器只找到 ${files.length} 个，疑似失配——这道闸已经失明`);
  for (const file of files) {
    if (/codexBin:\s*['"]codex['"]/.test(read(file))) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    '这些文件把 codexBin 写成了字面量 "codex"，会引入对宿主机 PATH 的隐式依赖：'
    + '没装 codex 的机器上进程会静默死掉，而不是给出一条失败的用例。改用 process.execPath。',
  );
});

test('mock 入口把 CODEX_BIN 指向假二进制而不是真 codex', () => {
  const mockServer = read('scripts/mock-server.js');
  assert.match(
    mockServer,
    /process\.env\.CODEX_BIN\s*=\s*MOCK_CODEX/,
    'mock-server.js 必须显式覆盖 CODEX_BIN，否则 server.js 会 which codex 找到真的',
  );

  const mockCodex = read('scripts/mock-codex.sh');
  assert.match(
    mockCodex,
    /echo "mock-codex/,
    'mock-codex.sh 的 --version 必须自报 mock-codex —— assert-mock-backend.js 拿它当运行时判据',
  );
});
