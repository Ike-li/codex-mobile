// test/unit/doctor-checks.test.mjs —— 自检判定层。
//
// 自检出错的症状是「它说没问题」，所以这一层的覆盖要厚。重点断言的不是文案，
// 而是**每条判定的方向**：什么时候该 fail、什么时候只该 warn、什么时候不能报 ok。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authTokenDiagnostic, bindDiagnostic, codexBinDiagnostic, computeReadiness,
  configFormatDiagnostic, configPermsDiagnostic, dataDirDiagnostic, envOverrideDiagnostic,
  headlessDiagnostic, logSwitchDiagnostic, portDiagnostic, schemaVerdict,
  schemaProbeDiagnostic, versionPinDiagnostic, workdirsDiagnostic,
} from '../../src/ops/doctor-checks.js';

// ---- AUTH_TOKEN：判据随绑定面变化 ----

test('空令牌：只听本机是 warn，对外监听是 fail', () => {
  assert.equal(authTokenDiagnostic({ token: '', host: '127.0.0.1' }).status, 'warn');
  assert.equal(authTokenDiagnostic({ token: '', host: '0.0.0.0' }).status, 'fail');
});

test('对外监听时短令牌是 fail，只听本机时只是 warn', () => {
  assert.equal(authTokenDiagnostic({ token: 'short', host: '0.0.0.0' }).status, 'fail');
  assert.equal(authTokenDiagnostic({ token: 'short', host: '127.0.0.1' }).status, 'warn');
  assert.equal(authTokenDiagnostic({ token: 'x'.repeat(64), host: '0.0.0.0' }).status, 'ok');
});

test('safe 字段不回显令牌本身——doctor 输出是人最常贴进 issue 的东西', () => {
  const secret = 'super-secret-token-value-here-32ch';
  const d = authTokenDiagnostic({ token: secret, host: '127.0.0.1' });
  assert.doesNotMatch(JSON.stringify(d), new RegExp(secret));
  assert.equal(d.safe.set, true);
  assert.equal(d.safe.length, secret.length);
});

// ---- BIND ----

test('只听本机是 ok，对外监听是 warn（不是 fail——那是有意的部署方式）', () => {
  assert.equal(bindDiagnostic({ host: '127.0.0.1', tokenLength: 0 }).status, 'ok');
  assert.equal(bindDiagnostic({ host: '0.0.0.0', tokenLength: 64 }).status, 'warn');
  assert.equal(bindDiagnostic({ host: '0.0.0.0', tokenLength: 10 }).status, 'fail', '令牌不够时 server 本来就会拒绝启动');
});

// ---- CODEX_BIN ----

test('找不到 codex 是 fail；找到但问不出版本只是 warn', () => {
  assert.equal(codexBinDiagnostic({}).status, 'fail');
  assert.equal(codexBinDiagnostic({ resolved: '/usr/bin/codex', exists: false }).status, 'fail');
  assert.equal(codexBinDiagnostic({ resolved: '/usr/bin/codex', exists: true, version: '' }).status, 'warn');
  assert.equal(codexBinDiagnostic({ resolved: '/usr/bin/codex', exists: true, version: '0.147.0' }).status, 'ok');
});

test('显式配了 CODEX_BIN 却找不到时，报错要说清是那个配置项', () => {
  const d = codexBinDiagnostic({ explicit: '/nope/codex' });
  assert.match(d.detail, /CODEX_BIN/);
  assert.match(d.detail, /\/nope\/codex/);
});

// ---- 版本 pin ----

test('版本不齐是 warn 不是 fail——硬闸是协议门禁，不是自检', () => {
  // 做成 fail 会让任何只想检查配置的人被一个与配置无关的问题挡住。
  const d = versionPinDiagnostic({ actual: '0.140.0', pinned: '0.147.0' });
  assert.equal(d.status, 'warn');
  assert.match(d.detail, /0\.147\.0/, '要给出对齐用的具体版本号');
  assert.equal(versionPinDiagnostic({ actual: '0.147.0', pinned: '0.147.0' }).status, 'ok');
});

test('问不出版本或没有 pin 文件时报 warn，不假装对齐', () => {
  assert.equal(versionPinDiagnostic({ actual: '', pinned: '0.147.0' }).status, 'warn');
  assert.equal(versionPinDiagnostic({ actual: '0.147.0', pinned: '' }).status, 'warn');
});

// ---- 状态库 ----

test('schemaVerdict 只对 schema 不兼容的错误开口', () => {
  assert.equal(schemaVerdict('no such table: threads_v5').compatible, false);
  assert.equal(schemaVerdict('connection refused').compatible, true);
  assert.equal(schemaVerdict('').compatible, true);
});

test('schema 探测没完成时报 warn，不静默当成通过', () => {
  // 静默当成通过等于这道检查不存在。
  assert.equal(schemaProbeDiagnostic({ compatible: true }).status, 'ok');
  assert.equal(schemaProbeDiagnostic({ compatible: true, probeError: 'timeout' }).status, 'warn');
  assert.equal(schemaProbeDiagnostic({ compatible: false, hint: '库旧了' }).status, 'fail');
});

// ---- 工作区 ----

test('一个工作区都没配是 fail，且说清「不回落家目录」', () => {
  const d = workdirsDiagnostic({ probes: [] });
  assert.equal(d.status, 'fail');
  assert.match(d.detail, /家目录/);
});

test('部分工作区不可用是 warn 并点名，全不可用是 fail', () => {
  const ok = { path: '/a', isDirectory: true, writable: true };
  const bad = { path: '/b', isDirectory: false, writable: false };
  assert.equal(workdirsDiagnostic({ probes: [ok, bad] }).status, 'warn');
  assert.match(workdirsDiagnostic({ probes: [ok, bad] }).detail, /\/b/);
  assert.equal(workdirsDiagnostic({ probes: [bad] }).status, 'fail');
  assert.equal(workdirsDiagnostic({ probes: [ok] }).status, 'ok');
});

test('工作区的 safe 只出计数，不出路径', () => {
  const d = workdirsDiagnostic({ probes: [{ path: '/home/me/secret-project', isDirectory: true, writable: true }] });
  assert.doesNotMatch(JSON.stringify(d.safe), /secret-project/);
});

// ---- 权限：三态 ----

test('权限查不了的平台报 warn，不报 ok——报 ok 是假绿', () => {
  assert.equal(configPermsDiagnostic({ problemCount: null }).status, 'warn');
  assert.equal(configPermsDiagnostic({ problemCount: 0, checked: 8 }).status, 'ok');
  assert.equal(configPermsDiagnostic({ problemCount: 2, checked: 8 }).status, 'fail');
});

// ---- 其余 ----

test('状态目录不可写是 fail，并说清后果', () => {
  const d = dataDirDiagnostic({ writable: false, path: '/x/data' });
  assert.equal(d.status, 'fail');
  assert.match(d.detail, /设备/);
});

test('端口被占用：可能是自己时 warn，否则 fail', () => {
  assert.equal(portDiagnostic({ free: true }).status, 'ok');
  assert.equal(portDiagnostic({ free: false, selfLikely: true }).status, 'warn');
  assert.equal(portDiagnostic({ free: false, selfLikely: false }).status, 'fail');
});

test('无图形界面恒 ok，两种环境文案不同', () => {
  assert.equal(headlessDiagnostic({}).status, 'ok');
  assert.equal(headlessDiagnostic({}).safe.headless, true);
  assert.equal(headlessDiagnostic({ display: ':0' }).safe.headless, false);
});

test('env 覆盖只报键名，不报值', () => {
  const d = envOverrideDiagnostic({ overridden: ['AUTH_TOKEN', 'PORT'] });
  assert.equal(d.status, 'warn');
  assert.match(d.detail, /AUTH_TOKEN/);
  assert.equal(envOverrideDiagnostic({ overridden: [] }).status, 'ok');
});

test('日志开关：RPC 日志接近上限时提前说', () => {
  assert.equal(logSwitchDiagnostic({}).status, 'ok');
  assert.equal(logSwitchDiagnostic({ stderr: true }).status, 'warn');
  assert.equal(logSwitchDiagnostic({ rpcLogBytes: 900, rpcLogCap: 1000 }).status, 'warn');
});

test('配置格式：没有配置文件是 fail，仍用 .env 是 warn', () => {
  assert.equal(configFormatDiagnostic({ source: 'none' }).status, 'fail');
  assert.equal(configFormatDiagnostic({ source: 'env' }).status, 'warn');
  assert.equal(configFormatDiagnostic({ source: 'config' }).status, 'ok');
  assert.equal(configFormatDiagnostic({ source: 'config', error: '坏 JSON' }).status, 'fail');
});

// ---- 聚合 ----

test('readiness 三档，且摘要点名是哪几项', () => {
  const mk = (id, status) => ({ id, status, detail: '' });
  assert.equal(computeReadiness([mk('A', 'ok')]).level, 'ready');
  assert.equal(computeReadiness([mk('A', 'ok'), mk('B', 'warn')]).level, 'caution');

  const blocked = computeReadiness([mk('A', 'warn'), mk('B', 'fail')]);
  assert.equal(blocked.level, 'blocked');
  assert.match(blocked.summary, /B/, '摘要要点名——只说「有 1 项失败」得再翻一遍输出');
});

test('所有判定函数在零参数下也能给出结论，不崩', () => {
  // 自检不该因为自己缺一个输入就整个跑不完。
  for (const fn of [authTokenDiagnostic, bindDiagnostic, codexBinDiagnostic, configFormatDiagnostic,
    configPermsDiagnostic, dataDirDiagnostic, envOverrideDiagnostic, headlessDiagnostic,
    logSwitchDiagnostic, portDiagnostic, schemaProbeDiagnostic, versionPinDiagnostic, workdirsDiagnostic]) {
    const d = fn();
    assert.ok(['ok', 'warn', 'fail'].includes(d.status), `${fn.name} 返回了非法 status`);
    assert.ok(d.id && d.detail, `${fn.name} 缺 id 或 detail`);
  }
});
