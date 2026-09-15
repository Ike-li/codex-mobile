// test/unit/statusline.test.mjs —— statusline 模块单元测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { buildStatusLine } from '../../statusline.js';

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-test-'));
  // Init git repo
  execSync('git init -q', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

// ---- buildStatusLine 基础测试 ----

test('statusline buildStatusLine: includes project name', async () => {
  const payload = await buildStatusLine({ agent: null, cwd: '/home/user/my-project', versions: null });
  assert.equal(payload.project, 'my-project');
  assert.equal(payload.cwd, '/home/user/my-project');
});

test('statusline buildStatusLine: null agent yields basic payload', async () => {
  const payload = await buildStatusLine({ agent: null, cwd: null, versions: null });
  assert.equal(payload.ts > 0, true);
  // state is undefined when no agent — only set when agent exists
  assert.equal(payload.state, undefined);
});

test('statusline buildStatusLine: agent 状态信息', async () => {
  const agent = {
    statusPayload: () => ({
      sessionId: 'sess_123',
      state: 'busy',
      busy: true,
      queueLength: 2,
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
    }),
  };
  const payload = await buildStatusLine({ agent, cwd: '/tmp/test', versions: { codex: '1.0.0' } });
  assert.equal(payload.sessionId, 'sess_123');
  assert.equal(payload.state, 'busy');
  assert.equal(payload.busy, true);
  assert.equal(payload.queueLength, 2);
  assert.equal(payload.approvalPolicy, 'on-request');
  assert.equal(payload.sandbox, 'read-only');
  assert.equal(payload.versions.codex, '1.0.0');
});

test('statusline buildStatusLine: cwd 末尾斜杠被清理', async () => {
  const payload = await buildStatusLine({ agent: null, cwd: '/tmp/test/', versions: null });
  assert.equal(payload.project, 'test');
});

// ---- git 集成测试 ----

test('git 状态: 在 git 仓库中返回分支信息', async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'test.txt'), 'hello');
    execSync('git add . && git commit -q -m "init"', { cwd: dir, stdio: 'ignore' });
    const payload = await buildStatusLine({ agent: null, cwd: dir, versions: null });
    assert.ok(payload.git);
    assert.equal(typeof payload.git.branch, 'string');
    // Default branch name varies by platform (main/master)
    assert.ok(['main', 'master'].includes(payload.git.branch));
    assert.equal(payload.git.changed, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git 状态: 检测未提交的更改', async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'a.txt'), 'initial');
    execSync('git add . && git commit -q -m "init"', { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, 'b.txt'), 'new file');
    writeFileSync(join(dir, 'a.txt'), 'modified');
    const payload = await buildStatusLine({ agent: null, cwd: dir, versions: null });
    assert.ok(payload.git);
    assert.equal(payload.git.changed > 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git 状态: 非 git 目录返回 null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-nogit-'));
  try {
    const payload = await buildStatusLine({ agent: null, cwd: dir, versions: null });
    assert.equal(payload.git, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- contextCost 测试 (通过 agent.tokenUsage) ----
// 字段名必须对齐 .protocol/stable/v2/TokenUsageBreakdown.ts 的 camelCase。
// 2026-09-10：这里曾断言 Anthropic Messages API 的 snake_case(input_tokens /
// cache_creation_input_tokens / cache_read_input_tokens)——那是从旧的
// `codex exec --json` 方案迁到 app-server 时留下的残留。测试镜像了实现，
// 于是三个字段在线上全部落到 `undefined || 0`，header 永远显示 0.0k 且不报错。

test('context usage: 用协议的 camelCase 字段算上下文占用', async () => {
  const agent = {
    statusPayload: () => ({ state: 'idle' }),
    tokenUsage: {
      last: {
        totalTokens: 82491,
        inputTokens: 80000,
        cachedInputTokens: 60000,
        cacheWriteInputTokens: 1200,
        outputTokens: 2491,
        reasoningOutputTokens: 800,
      },
      total: { totalTokens: 250000 },
      modelContextWindow: 272000,
    },
  };
  const payload = await buildStatusLine({ agent, cwd: null, versions: null });
  assert.ok(payload.ctx);
  assert.equal(payload.ctx.contextTokens, 82491);
  assert.equal(payload.ctx.contextWindow, 272000);
  assert.equal(payload.ctx.usedPct, Math.round((82491 / 272000) * 100));
});

test('context usage: 无 usage 时不设置 ctx', async () => {
  const agent = {
    statusPayload: () => ({ state: 'idle' }),
    tokenUsage: null,
  };
  const payload = await buildStatusLine({ agent, cwd: null, versions: null });
  assert.equal(payload.ctx, undefined);
});

// 字段名再次漂移时必须是「不显示」，不能是「显示一个可信的 0」——
// 后者正是上一版 bug 藏了这么久的原因。
test('context usage: 认不出字段时返回 null 而不是全零', async () => {
  const agent = {
    statusPayload: () => ({ state: 'idle' }),
    tokenUsage: { last: { input_tokens: 1000, cache_read_input_tokens: 300 } },
  };
  const payload = await buildStatusLine({ agent, cwd: null, versions: null });
  assert.equal(payload.ctx, undefined);
});

test('context usage: 缺 modelContextWindow 时仍报告绝对值，百分比为 null', async () => {
  const agent = {
    statusPayload: () => ({ state: 'idle' }),
    tokenUsage: { last: { totalTokens: 1800 }, modelContextWindow: null },
  };
  const payload = await buildStatusLine({ agent, cwd: null, versions: null });
  assert.ok(payload.ctx);
  assert.equal(payload.ctx.contextTokens, 1800);
  assert.equal(payload.ctx.contextWindow, null);
  assert.equal(payload.ctx.usedPct, null);
});

// ---- git 缓存测试 ----

test('git 缓存: 短时间内重复调用返回缓存结果', async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'test.txt'), 'hello');
    execSync('git add . && git commit -q -m "init"', { cwd: dir, stdio: 'ignore' });
    const p1 = await buildStatusLine({ agent: null, cwd: dir, versions: null });
    const p2 = await buildStatusLine({ agent: null, cwd: dir, versions: null });
    assert.deepEqual(p1.git, p2.git);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git 缓存: 并发调用共享同一次 git 查询', async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'test.txt'), 'hello');
    execSync('git add . && git commit -q -m "init"', { cwd: dir, stdio: 'ignore' });
    const [p1, p2, p3] = await Promise.all([
      buildStatusLine({ agent: null, cwd: dir, versions: null }),
      buildStatusLine({ agent: null, cwd: dir, versions: null }),
      buildStatusLine({ agent: null, cwd: dir, versions: null }),
    ]);
    // 缓存写在 5 次 await execGit 之后，所以并发调用会全部 miss，各自 spawn 5 个 git
    // 子进程——网关每 4 秒对每个已批准 socket 调一次，多设备下会放大成进程风暴。
    // 单飞后三者共享同一个 in-flight promise，因此拿到同一个对象引用；没有单飞时
    // 是三个内容相同但引用不同的对象。
    assert.equal(p1.git, p2.git);
    assert.equal(p2.git, p3.git);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
