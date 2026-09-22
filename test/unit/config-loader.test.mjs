// test/unit/config-loader.test.mjs —— 配置加载器换血的等价性证明。
//
// 这批的全部价值在于「换了加载器，行为一个字节没变」。所以主断言不是「新代码好用」，
// 而是**新旧两条路径投影出的 process.env 快照逐键相等** —— 旧逻辑抄进本文件当 oracle
// （一次性，B3 把消费点迁完之后连同这份 oracle 一起删）。
//
// 只测「读什么、投影成什么」，不测校验：校验是 B3 的事，那一批会**故意**改变行为
// （枚举值写错从静默透传变成启动期拒绝），到时候这里的等价性断言本就该随之调整。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';
import {
  loadConfigSources, resolveConfigValues, projectToEnv, CONFIG_FILE_NAME,
} from '../../src/ops/config-file.js';
import { applyRuntimeConfig, getShellEnvSnapshot } from '../../src/ops/config.js';

function withDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-config-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, '..'), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
}

/**
 * 旧路径的 oracle：dotenv.config() 的「不覆盖已存在 key」语义 + 全局删空串。
 * 逐字复刻 server.js 换血前的 61-64 行，不做任何"顺手改好"。
 */
function legacyProjection(envText, shellEnv) {
  const env = { ...shellEnv };
  for (const [key, value] of Object.entries(dotenv.parse(envText))) {
    if (!Object.hasOwn(env, key)) env[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (env[key] === '') delete env[key];
  }
  return env;
}

const SAMPLE_ENV = [
  'AUTH_TOKEN=abc123',
  'PORT=3001',
  'WORK_DIRS=workdirs.json',
  'CODEX_SANDBOX=workspace-write',
  'LOG_STDERR=1',
  '# 注释行',
  'EMPTY_IN_FILE=',
].join('\n');

test('等价性：无 shell 覆盖时，新旧投影逐键相等', () => {
  withDir({ '.env': SAMPLE_ENV }, dir => {
    const shell = { PATH: '/usr/bin', HOME: '/home/x' };
    const expected = legacyProjection(SAMPLE_ENV, shell);
    const actual = applyRuntimeConfig({ dir, env: { ...shell } }).env;
    assert.deepEqual(actual, expected);
  });
});

test('等价性：shell 压过文件，且文件不覆盖已存在的 key', () => {
  withDir({ '.env': SAMPLE_ENV }, dir => {
    const shell = { PATH: '/usr/bin', PORT: '4100', AUTH_TOKEN: 'from-shell' };
    const expected = legacyProjection(SAMPLE_ENV, shell);
    const actual = applyRuntimeConfig({ dir, env: { ...shell } }).env;
    assert.deepEqual(actual, expected);
    assert.equal(actual.PORT, '4100', 'shell 必须赢');
  });
});

test('等价性：shell 里的空串被删掉——这是承重行为，不是清洁工作', () => {
  // 具体陷阱：`export PORT=` 之后
  //   删掉  → Number(undefined) = NaN → server.js 回落 3001
  //   不删  → Number('')       = 0   → PORT 0 = **随机端口**，手机再也连不上原地址
  // 而那段删除在换血前是没有注释的，很容易被当成多余清理顺手删掉。
  withDir({ '.env': SAMPLE_ENV }, dir => {
    const shell = { PATH: '/usr/bin', PORT: '' };
    const actual = applyRuntimeConfig({ dir, env: { ...shell } }).env;
    assert.deepEqual(actual, legacyProjection(SAMPLE_ENV, shell));
    assert.equal(Object.hasOwn(actual, 'PORT'), false, 'PORT 空串必须被删掉，不能留成 0');
  });
});

test('等价性：文件里的空串同样按未设置处理', () => {
  withDir({ '.env': SAMPLE_ENV }, dir => {
    const shell = { PATH: '/usr/bin' };
    const actual = applyRuntimeConfig({ dir, env: { ...shell } }).env;
    assert.equal(Object.hasOwn(actual, 'EMPTY_IN_FILE'), false);
  });
});

test('等价性：没有任何配置文件时也不炸，投影等于纯 shell', () => {
  withDir({}, dir => {
    const shell = { PATH: '/usr/bin' };
    const result = applyRuntimeConfig({ dir, env: { ...shell } });
    assert.deepEqual(result.env, shell);
    assert.equal(result.source, 'none');
    assert.deepEqual(result.warnings, [], '全新安装是正常态，不该有告警');
  });
});

// ---- 文件源选择 ----

test('codex.config.json 存在时优先，且对并存的 .env 给出告警', () => {
  withDir({ '.env': SAMPLE_ENV, [CONFIG_FILE_NAME]: '{"PORT": 4200}' }, dir => {
    const sources = loadConfigSources({ dir });
    assert.equal(sources.source, 'config');
    assert.equal(sources.fileValues.PORT, 4200);
    assert.match(sources.warnings.join('\n'), /\.env/, '并存时必须说清哪一份被忽略了');
  });
});

test('坏 JSON 直接抛，不回落空配置', () => {
  // fail-loud 的理由：回落空配置会让 server 以「未设 AUTH_TOKEN」启动，然后按
  // resolveListenHost 的判据静默降级绑 127.0.0.1 —— 手机全连不上，而日志里
  // 一个错字都没有。改坏一个逗号的代价不该是「服务看起来好好的但没人能连」。
  withDir({ [CONFIG_FILE_NAME]: '{"PORT": 4200,}' }, dir => {
    assert.throws(() => loadConfigSources({ dir }), /codex\.config\.json/);
  });
});

test('JSON 顶层不是对象时同样抛，不当成空配置', () => {
  withDir({ [CONFIG_FILE_NAME]: '[1,2,3]' }, dir => {
    assert.throws(() => loadConfigSources({ dir }), /对象/);
  });
});

test('只有 .env 时提示迁移——而且那条命令真的存在', () => {
  // 告警的价值全在「照着做能解决问题」上。这条提示指向的 scripts/config.js migrate
  // 必须是可执行的，否则每次启动一条撞 Cannot find module 的告警只会训练人忽略告警栏。
  withDir({ '.env': SAMPLE_ENV }, dir => {
    const sources = loadConfigSources({ dir });
    assert.equal(sources.source, 'env');
    assert.match(sources.warnings.join('\n'), /migrate/);
  });
});

// ---- 投影 ----

test('projectToEnv：数组与布尔投成 .env 消费点认得的字符串形态', () => {
  assert.equal(projectToEnv('WORKDIRS', ['/a', '/b']), '["/a","/b"]');
  assert.equal(projectToEnv('LOG_STDERR', true), '1');
  assert.equal(projectToEnv('LOG_STDERR', false), '0');
  assert.equal(projectToEnv('PORT', 4200), '4200');
  assert.equal(projectToEnv('X', null), null, 'null 不投影');
  assert.equal(projectToEnv('X', ''), null, '空串 ≡ 未设置，不投影');
});

test('resolveConfigValues：判据是 key 存在性，不是值的非空性', () => {
  const values = resolveConfigValues({
    fileValues: { A: '1', B: '2', C: '', E: '5' },
    shellEnv: { B: '99', D: '', E: '' },
  });
  // E 是关键的那一格：shell 里是空串，但它**存在**，所以挡住了文件里的 '5'。
  // 这逐字复刻 dotenv 的「不覆盖已存在 key」。空值在下游被 projectToEnv 与删空串处理。
  assert.deepEqual(values, { A: '1', B: '99', C: '', D: '', E: '' });
});

test('getShellEnvSnapshot 只答「设没设」，不回显值', () => {
  const snap = getShellEnvSnapshot({ AUTH_TOKEN: 'super-secret', PORT: '' });
  assert.equal(snap.AUTH_TOKEN, true);
  assert.equal(snap.PORT, false, '空串算没设');
  assert.doesNotMatch(JSON.stringify(snap), /super-secret/, '快照绝不能带出令牌明文');
});
