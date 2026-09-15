// test/unit/doctor-runtime.test.mjs —— 自检的探测层与编排。
//
// 探测器全部注入外部边界（spawn / 绑端口）。不注入的话每个用例都要等真超时——
// 姊妹项目实测过，单文件从 1.5s 涨到 56.8s，而多出来的 55s 全是等待。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeCodexBin, probeConfigPerms, probeDataDir, probeEnvOverrides, probePort,
  probeWorkdirs, runDoctor, SENSITIVE_FILES,
} from '../../src/ops/doctor-runtime.js';

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ccm-doctor-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
}

// ---- codex 二进制 ----

test('没配 CODEX_BIN 时走 which；查不到就如实说查不到', () => {
  const found = probeCodexBin({ exec: (cmd, args) => (cmd === 'which' ? '/usr/local/bin/codex\n' : 'codex-cli 0.147.0\n') });
  assert.equal(found.resolved, '/usr/local/bin/codex');

  const missing = probeCodexBin({ exec: () => { throw new Error('not found'); } });
  assert.equal(missing.resolved, '');
  assert.equal(missing.exists, false);
});

test('问版本失败不影响「找到了」这个事实，单独记 versionError', () => {
  // 两件事分开报：找不到 codex 和「找到了但跑不起来」的下一步动作完全不同。
  withRoot(root => {
    const bin = join(root, 'codex');
    writeFileSync(bin, '#!/bin/sh\n');
    const r = probeCodexBin({
      explicit: bin,
      exec: (cmd) => { if (cmd === bin) throw new Error('permission denied'); return ''; },
    });
    assert.equal(r.exists, true);
    assert.equal(r.version, '');
    assert.match(r.versionError, /permission denied/);
  });
});

// ---- 工作区 ----

test('工作区探测把「不是目录」和「不可写」分开记', () => {
  withRoot(root => {
    const dir = join(root, 'ok');
    mkdirSync(dir);
    const file = join(root, 'a-file');
    writeFileSync(file, '');
    const probes = probeWorkdirs([dir, file, join(root, 'missing')]);
    assert.deepEqual(probes.map(p => p.isDirectory), [true, false, false]);
    assert.equal(probes[0].writable, true);
  });
});

// ---- 状态目录 ----

test('状态目录不存在时创建它，并报可写', () => {
  withRoot(root => {
    const dir = join(root, 'data');
    const r = probeDataDir(dir);
    assert.equal(r.writable, true);
    assert.equal(r.path, dir);
  });
});

// ---- 权限：三态 ----

test('权限探测数出过宽的文件', () => {
  withRoot(root => {
    writeFileSync(join(root, 'codex.config.json'), '{}');
    chmodSync(join(root, 'codex.config.json'), 0o644);
    const r = probeConfigPerms({ root, platform: 'darwin' });
    assert.equal(r.problemCount, 1);
    assert.equal(r.checked, 1);
  });
});

test('Windows 上返回 null 而不是 0——假报 0 会让人以为查过了', () => {
  withRoot(root => {
    assert.equal(probeConfigPerms({ root, platform: 'win32' }).problemCount, null);
  });
});

test('敏感文件清单覆盖配置与全部状态文件', () => {
  for (const name of ['codex.config.json', '.env', 'data/trusted-devices.json', 'data/enrollment-token']) {
    assert.ok(SENSITIVE_FILES.includes(name), `${name} 不在敏感文件清单里`);
  }
});

// ---- 端口 ----

test('端口能绑就是空闲，EADDRINUSE 就是占用', async () => {
  const freeStub = () => {
    const handlers = {};
    return {
      once: (evt, fn) => { handlers[evt] = fn; },
      listen: () => handlers.listening?.(),
      close: cb => cb(),
    };
  };
  assert.deepEqual(await probePort(1234, { createServer: freeStub }), { free: true });

  const busyStub = () => {
    const handlers = {};
    return {
      once: (evt, fn) => { handlers[evt] = fn; },
      listen: () => handlers.error?.({ code: 'EADDRINUSE' }),
      close: cb => cb(),
    };
  };
  assert.equal((await probePort(1234, { createServer: busyStub })).free, false);
});

// ---- env 覆盖 ----

test('只报已登记的配置键，且空串不算「设了」', () => {
  const overridden = probeEnvOverrides({
    shellEnv: { PORT: '4100', AUTH_TOKEN: '', SOMETHING_ELSE: 'x' },
  });
  assert.deepEqual(overridden, ['PORT'], '空串的 AUTH_TOKEN 与未登记的 SOMETHING_ELSE 都不该进来');
});

// ---- 编排 ----

test('runDoctor 产出固定项数与 readiness', () => {
  const { checks, readiness } = runDoctor({});
  // 这条断言刻意脆弱：改项数必须显式改测试，否则少了一项没人会发现。
  assert.equal(checks.length, 12);
  assert.ok(['ready', 'caution', 'blocked'].includes(readiness.level));
  assert.equal(new Set(checks.map(c => c.id)).size, checks.length, '有重复的检查 id');
});

test('没跑 schema 探测时**不出**这一项，而不是出一个 ok', () => {
  // 出 ok 是假绿：它会让人以为状态库查过了。
  assert.equal(runDoctor({}).checks.some(c => c.id === 'SCHEMA_PROBE'), false);
  const withProbe = runDoctor({ schemaProbe: { id: 'SCHEMA_PROBE', status: 'ok', detail: '' } });
  assert.equal(withProbe.checks.length, 13);
});

test('任一项 fail 就 blocked，退出码据此决定', () => {
  const r = runDoctor({ workdirProbes: [] });   // 没工作区 = fail
  assert.equal(r.readiness.level, 'blocked');
});
