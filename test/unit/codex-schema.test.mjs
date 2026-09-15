// test/unit/codex-schema.test.mjs —— 配置 schema 的归一与校验。
//
// 主断言是**默认值与阈值逐项等于换血前那 8 段手写归一**。旧代码抄进本文件当 oracle
// （一次性）——不这么做的话，「把散落的默认值收进一张表」这件事没有任何东西能证明
// 收对了，而收错一个默认值的症状是「某个限额悄悄变了」，不会有任何报错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_SCHEMA, coerceValue, checkOne, validateConfig,
  DEFAULT_PORT, MIN_AGENT_IDLE_TTL_MS, ALL_CONFIG_KEYS, isSecret,
} from '../../src/ops/codex-schema.js';

// 换血前 server.js 里那 8 段三元表达式的默认值，逐字抄来。
const LEGACY_DEFAULTS = {
  PORT: 3001,
  IDLE_TIMEOUT_MS: 600_000,
  CODEX_PUSH_MAX_SUBSCRIPTIONS: 64,
  CODEX_AUTH_MAX_FAILURES: 5,
  CODEX_AUTH_WINDOW_MS: 60_000,
  CODEX_SECURITY_AUDIT_MAX_BYTES: 1024 * 1024,
  CODEX_PENDING_DEVICE_LIMIT: 32,
  CODEX_AGENT_IDLE_TTL_MS: 30 * 60 * 1000,
  CODEX_SESSION_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  // agent-appserver.js 那份 numberFromEnv 的默认值
  CODEX_EVENT_BUFFER_CAP: 500,
  CODEX_INPUT_QUEUE_LIMIT: 20,
  CODEX_INTERRUPT_TIMEOUT_MS: 2000,
  CODEX_RPC_LOG_MAX_BYTES: 8 * 1024 * 1024,
};

test('默认值逐项等于换血前的手写归一', () => {
  for (const [key, expected] of Object.entries(LEGACY_DEFAULTS)) {
    assert.equal(CODEX_SCHEMA[key].default, expected, `${key} 的默认值变了`);
    assert.equal(coerceValue(key, undefined), expected, `${key} 未设置时应回落默认值`);
    assert.equal(coerceValue(key, ''), expected, `${key} 空串应按未设置处理`);
  }
});

test('PORT 的下界是 0 不是 1——0 是「随机端口」这个被使用的语义', () => {
  assert.equal(CODEX_SCHEMA.PORT.min, 0);
  assert.equal(coerceValue('PORT', '0'), 0, '照搬「端口必须 >= 1」会静默把 0 换成 3001');
  assert.equal(coerceValue('PORT', '-1'), DEFAULT_PORT);
  assert.equal(coerceValue('PORT', '70000'), DEFAULT_PORT, '超出 65535 回落默认');
});

test('CODEX_AGENT_IDLE_TTL_MS 保留一分钟下界', () => {
  assert.equal(CODEX_SCHEMA.CODEX_AGENT_IDLE_TTL_MS.min, MIN_AGENT_IDLE_TTL_MS);
  // 误配成 0 时，任何断开连接的会话都会在下一个 5 分钟 tick 里被立刻回收。
  assert.equal(coerceValue('CODEX_AGENT_IDLE_TTL_MS', '0'), 30 * 60 * 1000);
  assert.equal(coerceValue('CODEX_AGENT_IDLE_TTL_MS', '59999'), 30 * 60 * 1000);
  assert.equal(coerceValue('CODEX_AGENT_IDLE_TTL_MS', '60000'), 60_000, '恰好等于下界应被接受');
});

test('非整数一律回落默认值', () => {
  // 换血前 IDLE_TIMEOUT_MS 这一项用的是 `Number(x) > 0` 而**不查 isInteger**，
  // 于是 '600.5' 会被原样接受。统一成整数语义是本批有意的收敛：一个分数毫秒
  // 没有任何合理用途，而「八项里有一项判据不同」本身就是将来读错代码的来源。
  assert.equal(coerceValue('IDLE_TIMEOUT_MS', '600.5'), 600_000);
  assert.equal(coerceValue('PORT', 'abc'), DEFAULT_PORT);
});

test('枚举：合法值原样通过，非法值回落默认且 checkOne 报错', () => {
  assert.equal(coerceValue('CODEX_SANDBOX', 'read-only'), 'read-only');
  assert.equal(coerceValue('CODEX_SANDBOX', 'nonsense'), 'workspace-write');
  // 这是本批唯一改变行为的地方：此前 `process.env.X || '默认'` 会把 'nonsense'
  // 原样透传给 app-server，行为不对而日志里什么都没有。
  assert.match(checkOne('CODEX_SANDBOX', 'nonsense'), /只能是/);
  assert.equal(checkOne('CODEX_SANDBOX', 'read-only'), null);
  assert.match(checkOne('CODEX_APPROVAL_POLICY', 'on-requset'), /on-request/,
    '报错里要带上正确拼写——拼错一个字母是这类配置最常见的失败方式');
});

test('toggle：JSON boolean 与 .env 字符串两种形态都认', () => {
  assert.equal(coerceValue('LOG_STDERR', true), true);
  assert.equal(coerceValue('LOG_STDERR', '1'), true);
  assert.equal(coerceValue('LOG_STDERR', 'on'), true);
  assert.equal(coerceValue('LOG_STDERR', '0'), false);
  assert.equal(coerceValue('LOG_STDERR', 'anything-else'), false);
});

test('CODEX_RPC_LOG 缺省是开——消费点的判据是 === \'0\' 才关', () => {
  assert.equal(CODEX_SCHEMA.CODEX_RPC_LOG.default, true);
  assert.equal(coerceValue('CODEX_RPC_LOG', undefined), true);
});

test('list：JSON 数组、JSON 字面量串、逗号串三种都认', () => {
  assert.deepEqual(coerceValue('WORKDIRS', ['/a', '/b']), ['/a', '/b']);
  assert.deepEqual(coerceValue('WORKDIRS', '["/a","/b"]'), ['/a', '/b']);
  assert.deepEqual(coerceValue('WORKDIRS', '/a, /b'), ['/a', '/b'], '逗号串是 .env 时代的形态，迁移期仍要认');
  assert.deepEqual(coerceValue('WORKDIRS', '[坏 JSON'), []);
});

test('失败方向按 kind 分档：枚举非法拒绝启动，数值越界只回落并告警', () => {
  // 这两档不是「严格程度不同」，是**错法的代价不同**：
  //   枚举拼错一个字母就换了一套安全边界（沙箱模式 / 审批策略），而回落不会有任何提示，
  //     用户会以为自己配的那套在生效——必须当场停下来。
  //   数值越界回落到默认值是本仓已经选过并测过的方向（server-integration 有一条用例
  //     就叫「an out-of-range idle TTL falls back to the default」）。改成拒绝启动意味着
  //     一次升级就能让一台原本跑得好好的部署起不来，代价不对称。
  const enumBad = validateConfig({ CODEX_SANDBOX: 'nope' });
  assert.equal(enumBad.ok, false);
  assert.equal(enumBad.errors.length, 1);

  const numberBad = validateConfig({ PORT: '99999', CODEX_AGENT_IDLE_TTL_MS: '0' });
  assert.equal(numberBad.ok, true, '数值越界不阻断启动');
  assert.equal(numberBad.errors.length, 0);
  assert.equal(numberBad.warnings.length, 2);
  assert.match(numberBad.warnings.join('\n'), /已回落默认值 3001/, '告警要说清回落到了什么值');

  const half = validateConfig({ VAPID_PUBLIC_KEY: 'k', VAPID_SUBJECT: 'mailto:a@b.c' });
  assert.equal(half.ok, true, '配一半不阻断启动——推送不可用，但服务本身是好的');
  assert.match(half.warnings.join('\n'), /VAPID_PRIVATE_KEY/);

  const none = validateConfig({});
  assert.equal(none.ok, true);
  assert.deepEqual(none.warnings, [], '一项都没配是正常态，不该告警');
});

test('validateConfig 不校验 passthrough 与未登记的键', () => {
  const r = validateConfig({ CODEX_DATA_DIR: '/tmp/x', SOMETHING_ELSE: 'whatever' });
  assert.equal(r.ok, true);
});

test('AUTH_TOKEN 是 readonly 且 secret', () => {
  // 改它到重启之间文件与进程不一致，重启后含正在操作的这台手机在内全部要重输——
  // 极易把自己锁在门外。所以它只能由 setup 写，不走常规 set。
  assert.equal(CODEX_SCHEMA.AUTH_TOKEN.kind, 'readonly');
  assert.equal(isSecret(CODEX_SCHEMA.AUTH_TOKEN), true);
  assert.equal(isSecret(CODEX_SCHEMA.VAPID_PRIVATE_KEY), true);
  assert.equal(isSecret(CODEX_SCHEMA.PORT), false);
});

test('ALL_CONFIG_KEYS 覆盖 schema 与 passthrough，且无重复', () => {
  assert.equal(new Set(ALL_CONFIG_KEYS).size, ALL_CONFIG_KEYS.length, '有重复键');
  for (const key of Object.keys(CODEX_SCHEMA)) assert.ok(ALL_CONFIG_KEYS.includes(key));
});
