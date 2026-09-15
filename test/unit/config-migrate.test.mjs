// test/unit/config-migrate.test.mjs —— .env → codex.config.json 的一次性迁移。
//
// 迁移的危险不在于失败，在于**报成功而悄悄少搬了东西**。工作区少一个、主目录换了一个，
// 用户下次打开手机才会发现，而那时已经没有 .env 可以对照了。所以这里的断言几乎全是
// 「这一项有没有被保住」，而不是「格式对不对」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateEnvValues } from '../../src/ops/config-file.js';

function withDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-migrate-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
}

test('数值与开关按 schema 归一成 JSON 的原生类型，不留字符串', () => {
  const { config } = migrateEnvValues({ PORT: '4100', LOG_STDERR: '1', CODEX_RPC_LOG: '0' });
  assert.equal(config.PORT, 4100);
  assert.equal(config.LOG_STDERR, true);
  assert.equal(config.CODEX_RPC_LOG, false);
});

test('WORK_DIRS 指向 JSON 文件时读出来内联，并告知那个文件不再被读', () => {
  withDir({ 'workdirs.json': JSON.stringify(['/a', '/b']) }, dir => {
    const { config, warnings } = migrateEnvValues({ WORK_DIRS: 'workdirs.json' }, { baseDir: dir });
    assert.deepEqual(config.WORKDIRS, ['/a', '/b']);
    assert.equal(Object.hasOwn(config, 'WORK_DIRS'), false, '旧键不该留下——留着就成了「看起来是事实源、实际已失效」的文件');
    assert.match(warnings.join('\n'), /workdirs\.json/);
  });
});

test('WORK_DIRS 指向的文件读不出来时**保留原键并告警**，不静默丢弃', () => {
  // 静默丢弃的后果是迁移后只剩一个工作区，而迁移报的是成功。保留原键至少让
  // 下一次启动仍然按旧路径工作，且告警里说得出是哪个文件。
  withDir({}, dir => {
    const { config, warnings } = migrateEnvValues({ WORK_DIRS: 'missing.json' }, { baseDir: dir });
    assert.equal(config.WORK_DIRS, 'missing.json');
    assert.match(warnings.join('\n'), /missing\.json/);
  });
});

test('WORK_DIRS 是逗号串时拆成数组', () => {
  const { config } = migrateEnvValues({ WORK_DIRS: '/a, /b ,/c' });
  assert.deepEqual(config.WORKDIRS, ['/a', '/b', '/c']);
});

test('WORK_DIR 折进 WORKDIRS 首项——它就是手机端默认打开的目录', () => {
  const { config } = migrateEnvValues({ WORK_DIR: '/primary', WORK_DIRS: '/a,/b' });
  assert.deepEqual(config.WORKDIRS, ['/primary', '/a', '/b']);
  assert.equal(Object.hasOwn(config, 'WORK_DIR'), false);
});

test('WORK_DIR 已经在列表里时提到首位，不重复', () => {
  const { config } = migrateEnvValues({ WORK_DIR: '/b', WORK_DIRS: '/a,/b,/c' });
  assert.deepEqual(config.WORKDIRS, ['/b', '/a', '/c']);
});

test('只有 WORK_DIR 没有 WORK_DIRS 时也要保住它', () => {
  // 丢掉它等于悄悄换了手机端默认打开的目录，而迁移报的是「成功」。
  const { config } = migrateEnvValues({ WORK_DIR: '/only' });
  assert.deepEqual(config.WORKDIRS, ['/only']);
});

test('折叠顺序不可换：先内联文件，再折 WORK_DIR', () => {
  withDir({ 'wd.json': JSON.stringify(['/a']) }, dir => {
    const { config } = migrateEnvValues({ WORK_DIR: '/primary', WORK_DIRS: 'wd.json' }, { baseDir: dir });
    // 顺序反了的话，WORK_DIR 会折进一个还没展开的字符串上，结果只剩它自己。
    assert.deepEqual(config.WORKDIRS, ['/primary', '/a']);
  });
});

test('未登记的键原样保留，不静默吃掉', () => {
  // 吃掉一个自定义键与「它本来就没配」在行为上一样，而用户会以为迁移搬全了。
  const { config, warnings } = migrateEnvValues({ SOMETHING_CUSTOM: 'keep-me' });
  assert.equal(config.SOMETHING_CUSTOM, 'keep-me');
  assert.match(warnings.join('\n'), /SOMETHING_CUSTOM/, '保留了但要说一声——它不在 schema 里，没人给它校验');
});

test('passthrough 键原样保留且不告警', () => {
  const { config, warnings } = migrateEnvValues({ CODEX_DATA_DIR: '/var/lib/ccm' });
  assert.equal(config.CODEX_DATA_DIR, '/var/lib/ccm');
  assert.deepEqual(warnings, []);
});

test('产出带 $schemaVersion，便于将来识别格式代次', () => {
  const { config } = migrateEnvValues({ PORT: '3001' });
  assert.equal(config.$schemaVersion, 1);
});

test('空串按未设置处理，不写进 JSON', () => {
  const { config } = migrateEnvValues({ PORT: '', AUTH_TOKEN: 'keep' });
  assert.equal(Object.hasOwn(config, 'PORT'), false);
  assert.equal(config.AUTH_TOKEN, 'keep');
});
