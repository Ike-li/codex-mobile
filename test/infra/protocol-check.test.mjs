import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_METHOD_ALLOWLIST,
  EXPERIMENTAL_METHOD_ALLOWLIST,
  collectBridgeMethodUsage,
  diffMethodSets,
  diffProtocolFiles,
  diffTypeSets,
  findMissingProtocolCoverage,
  formatMissingProtocolCoverage,
  formatProtocolDrift,
  hasProtocolDrift,
  parseProtocolMethods,
  readPinnedCodexVersion,
  readProtocolMethodSets,
  readProtocolTypeSet,
  LEGACY_FIELD_ALLOWLIST,
  parseNotificationParamsTypes,
  readTypeFields,
  readAllNotificationParamsFields,
  collectNotificationFieldUsage,
  findUnknownNotificationFields,
  formatUnknownNotificationFields,
  parseRequestParamsTypes,
  collectOmittedRequestParams,
  findOmittedRequiredParams,
  formatOmittedRequiredParams,
  protocolCheckFailed,
} from '../../scripts/gates/protocol-check.mjs';

const root = process.cwd();
const protocolDir = join(root, '.protocol', 'stable');

function currentBridgeUsage() {
  return collectBridgeMethodUsage({
    agentAppserverSource: readFileSync(join(root, 'src', 'agent', 'agent-appserver.js'), 'utf8'),
    approvalBrokerSource: readFileSync(join(root, 'src', 'agent', 'approval-broker.js'), 'utf8'),
  });
}

test('protocol check accepts current bridge methods against the stable export fixture', () => {
  const protocol = readProtocolMethodSets(protocolDir);
  const usage = currentBridgeUsage();

  assert.deepEqual(findMissingProtocolCoverage({ usage, protocol }), []);
});

test('protocol check reports a bridge method missing from the generated protocol export', () => {
  const protocol = readProtocolMethodSets(protocolDir);
  const usage = currentBridgeUsage();
  usage.clientRequests.add('thread/nonexistentForTest');

  const missing = findMissingProtocolCoverage({ usage, protocol });

  assert.deepEqual(missing, [{
    direction: 'clientRequests',
    protocolType: 'ClientRequest',
    method: 'thread/nonexistentForTest',
  }]);
  assert.match(formatMissingProtocolCoverage(missing), /ClientRequest/);
  assert.match(formatMissingProtocolCoverage(missing), /thread\/nonexistentForTest/);
});

test('protocol check exempts probed experimental client requests such as thread/settings/update', () => {
  const protocol = readProtocolMethodSets(protocolDir);
  const usage = {
    serverNotifications: new Set(),
    clientRequests: new Set(['thread/settings/update']),
    clientNotifications: new Set(),
    serverRequests: new Set(),
  };

  assert.equal(EXPERIMENTAL_METHOD_ALLOWLIST.has('thread/settings/update'), true);
  assert.equal(protocol.clientRequests.has('thread/settings/update'), false);
  assert.deepEqual(findMissingProtocolCoverage({ usage, protocol }), []);
});

test('protocol check exempts explicit legacy methods such as turn/failed', () => {
  const protocol = readProtocolMethodSets(protocolDir);
  const usage = {
    serverNotifications: new Set(['turn/failed']),
    clientRequests: new Set(),
    clientNotifications: new Set(),
    serverRequests: new Set(),
  };

  assert.equal(LEGACY_METHOD_ALLOWLIST.has('turn/failed'), true);
  assert.deepEqual(findMissingProtocolCoverage({ usage, protocol }), []);
});

test('collectBridgeMethodUsage reads the handleNotification definition, not an earlier call site', () => {
  // Regression: extractFunctionBody matched `this.handleNotification(` before the real
  // method definition, so `msg.params || {}` was mistaken for the body and zero cases
  // were collected — silently voiding the notification coverage gate.
  const agentAppserverSource = [
    'class Bridge {',
    '  onMessage(msg) {',
    '    this.handleNotification(msg.method, msg.params || {});',
    '  }',
    '  handleNotification(method, params) {',
    '    switch (method) {',
    "      case 'turn/completed': return this.done(params);",
    "      case 'item/started': return this.start(params);",
    '    }',
    '  }',
    '}',
  ].join('\n');

  const usage = collectBridgeMethodUsage({ agentAppserverSource, approvalBrokerSource: '' });

  assert.deepEqual([...usage.serverNotifications].sort(), ['item/started', 'turn/completed']);
});

test('collectBridgeMethodUsage extracts the real handleNotification cases so notification coverage is enforced', () => {
  const usage = currentBridgeUsage();

  assert.ok(
    usage.serverNotifications.size >= 30,
    `notification coverage set should be populated, got ${usage.serverNotifications.size}`,
  );
  for (const method of ['turn/completed', 'item/started', 'item/completed']) {
    assert.ok(usage.serverNotifications.has(method), `missing handled notification ${method}`);
  }
});

test('protocol drift report describes method, type, and generated file changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-drift-'));
  try {
    const baseline = join(dir, 'baseline');
    const current = join(dir, 'current');
    writeProtocolFixture(baseline, {
      ServerNotification: ['turn/completed'],
      ClientRequest: ['turn/start'],
      ServerRequest: ['item/commandExecution/requestApproval'],
      ClientNotification: ['initialized'],
      ExtraOnlyInBaseline: [],
      Changed: ['old/method'],
    });
    writeProtocolFixture(current, {
      ServerNotification: ['turn/completed', 'error'],
      ClientRequest: ['turn/start'],
      ServerRequest: [],
      ClientNotification: ['initialized'],
      ExtraOnlyInCurrent: [],
      Changed: ['new/method'],
    });

    const methodDiff = diffMethodSets(readProtocolMethodSets(baseline), readProtocolMethodSets(current));
    const typeDiff = diffTypeSets(readProtocolTypeSet(baseline), readProtocolTypeSet(current));
    const fileDiff = diffProtocolFiles(baseline, current);
    const report = formatProtocolDrift({ methodDiff, typeDiff, fileDiff });

    assert.equal(hasProtocolDrift({ methodDiff, typeDiff, fileDiff }), true);
    assert.match(report, /ServerNotification methods/);
    assert.match(report, /error/);
    assert.match(report, /item\/commandExecution\/requestApproval/);
    assert.match(report, /Type files/);
    assert.match(report, /ExtraOnlyInCurrent/);
    assert.match(report, /ExtraOnlyInBaseline/);
    assert.match(report, /Generated files/);
    assert.match(report, /Changed\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('protocol helpers parse generated method literals and pinned version files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-pin-'));
  try {
    const pinFile = join(dir, '.codex-version');
    writeFileSync(pinFile, '0.142.5\n');

    assert.equal(readPinnedCodexVersion(pinFile), '0.142.5');
    assert.deepEqual(parseProtocolMethods(`
      export type ServerNotification =
        | { "method": "turn/completed", "params": unknown }
        | { 'method': 'error', 'params': unknown };
    `), new Set(['turn/completed', 'error']));
    assert.equal(formatProtocolDrift({
      methodDiff: {
        ServerNotification: { added: [], removed: [] },
        ClientRequest: { added: [], removed: [] },
        ServerRequest: { added: [], removed: [] },
        ClientNotification: { added: [], removed: [] },
      },
      typeDiff: { added: [], removed: [] },
      fileDiff: { added: [], removed: [], changed: [] },
    }), 'Protocol export drift: OK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 这条测的是「PATH 上的 codex 与 pin 一致时,CLI 走完全程并报 OK」,而不是「pin 恰好等于
// 某个版本号」。把版本号写死会让每次协议升级都顺带改这里,改的还是与被测行为无关的字面量
// ——0.142.5 → 0.147.0 那次就是这么红的。让假 codex 直接照着事实源报版本。
test('protocol check CLI succeeds against a pinned fake codex export', () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-cli-'));
  const pinned = readFileSync(join(root, '.codex-version'), 'utf8').trim();
  try {
    const fakeBin = join(dir, 'bin');
    const fakeCodex = join(fakeBin, 'codex');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeCodex, [
      '#!/usr/bin/env node',
      "import { cpSync, rmSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const args = process.argv.slice(2);",
      `if (args[0] === '--version') { console.log('codex-cli ${pinned}'); process.exit(0); }`,
      "if (args[0] === 'app-server' && args[1] === 'generate-ts') {",
      "  const out = args[args.indexOf('--out') + 1];",
      "  rmSync(out, { recursive: true, force: true });",
      "  cpSync(join(process.env.CCM_REPO_ROOT, '.protocol', 'stable'), out, { recursive: true });",
      "  process.exit(0);",
      "}",
      "console.error(`unexpected fake codex args: ${args.join(' ')}`);",
      "process.exit(2);",
    ].join('\n'));
    chmodSync(fakeCodex, 0o755);

    const result = spawnSync(process.execPath, ['scripts/gates/protocol-check.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CCM_REPO_ROOT: root,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(`Codex protocol pin: ${pinned.replace(/\./g, '\\.')}`));
    assert.match(result.stdout, /Protocol export drift: OK/);
    assert.match(result.stdout, /Protocol coverage: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeProtocolFixture(dir, methodFiles) {
  mkdirSync(dir, { recursive: true });
  for (const [typeName, methods] of Object.entries(methodFiles)) {
    const body = methods.length
      ? methods.map(method => `| { "method": "${method}", "params": unknown }`).join('\n')
      : '| { "type": "placeholder" }';
    writeFileSync(join(dir, `${typeName}.ts`), `export type ${typeName} =\n${body};\n`);
  }
}

// 字段级漂移。此前 protocol:check 只比对方法名和「上游生成的文件有没有变」，
// 从不校验我们的代码读的 params 字段是否真的存在于协议里。上游把字段改个名，
// 我们读到的是 undefined —— 没有异常、没有失败用例，功能静默失效，而单元测试
// 用的是我们自己写的、同样假设错误的 fixture，两层一起说谎。
test('通知字段用法对得上协议：解析 ServerNotification 的 method → params 类型', () => {
  const source = `
export type ServerNotification = { "method": "turn/started", "params": TurnStartedNotification } | { "method": "process/exited", "params": ProcessExitedNotification };
`;
  const map = parseNotificationParamsTypes(source);
  assert.equal(map.get('turn/started'), 'TurnStartedNotification');
  assert.equal(map.get('process/exited'), 'ProcessExitedNotification');
  assert.equal(map.size, 2);
});

test('通知字段用法对得上协议：读出 params 类型声明的顶层字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-fields-'));
  try {
    writeFileSync(join(dir, 'ThingNotification.ts'),
      'export type ThingNotification = { threadId: string, threadName?: string, };\n');
    const fields = readTypeFields(dir, 'ThingNotification');
    assert.deepEqual([...fields].sort(), ['threadId', 'threadName']);
    assert.equal(readTypeFields(dir, 'MissingNotification'), null, '找不到的类型返回 null 而不是空集合');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('通知字段用法对得上协议：从 handleNotification 抽出每个 method 读的字段', () => {
  const source = `
  handleNotification(method, params) {
    switch (method) {
      case 'turn/started':
        this.emit('x', { id: params.turnId });
        break;
      case 'process/exited':
        this.emit('y', { h: params.processHandle, code: params.exitCode });
        break;
    }
  }
`;
  const usage = collectNotificationFieldUsage(source);
  assert.deepEqual([...usage.get('turn/started')], ['turnId']);
  assert.deepEqual([...usage.get('process/exited')].sort(), ['exitCode', 'processHandle']);
});

test('通知字段用法对得上协议：报告协议里不存在的字段，白名单里的兼容回退除外', () => {
  const usage = new Map([
    ['turn/started', new Set(['turnId', 'bogusField'])],
    ['process/exited', new Set(['processHandle', 'processId'])],
  ]);
  const paramsTypes = new Map([
    ['turn/started', 'TurnStartedNotification'],
    ['process/exited', 'ProcessExitedNotification'],
  ]);
  const declared = new Map([
    ['TurnStartedNotification', new Set(['turnId'])],
    ['ProcessExitedNotification', new Set(['processHandle', 'exitCode'])],
  ]);
  const allowlist = new Map([['process/exited', new Set(['processId'])]]);

  const unknown = findUnknownNotificationFields({ usage, paramsTypes, declared, allowlist });
  assert.deepEqual(unknown, [
    { method: 'turn/started', paramsType: 'TurnStartedNotification', fields: ['bogusField'] },
  ], 'bogusField 要报出来，白名单里的 processId 不报');
  assert.match(formatUnknownNotificationFields(unknown), /bogusField/);
  assert.match(formatUnknownNotificationFields([]), /OK/);
});

test('通知字段用法对得上协议：真实的 agent-appserver.js 对着真实协议没有未知字段', () => {
  const unknown = findUnknownNotificationFields({
    usage: collectNotificationFieldUsage(readFileSync(join(root, 'src', 'agent', 'agent-appserver.js'), 'utf8')),
    paramsTypes: parseNotificationParamsTypes(readFileSync(join(protocolDir, 'ServerNotification.ts'), 'utf8')),
    declared: readAllNotificationParamsFields(protocolDir),
    allowlist: LEGACY_FIELD_ALLOWLIST,
  });
  assert.deepEqual(unknown, [], formatUnknownNotificationFields(unknown));
});

// 字段解析面塌陷 —— 「扫不出字段」与「字段都对得上」在输出上无法区分，而前者意味着这道闸失明了。
//
// 【失败形态】上游把 params 类型从 `export type X = { ... }` 改成 `export interface X { ... }`：
// readTypeFields 的正则（`export type \w+\s*=\s*\{`）全不匹配 → 每个类型返回 null →
// readAllNotificationParamsFields 的 `if (fields)` 把它们全部丢弃 → declared 为空 →
// findUnknownNotificationFields 的 `if (!declaredFields) continue` 把每个 method 都跳过 →
// 「Notification field usage: OK」→ 退出码 0。
//
// 【为什么方法覆盖那侧兜不住】method 名走的是另一个正则（`"method": "x"`），与字段解析互相独立。
// 2026-09-08 实测：拿真实 .protocol/stable/ 做夹具、只把 params 类型文件改成 interface 写法，
// 方法覆盖 missing = 0，declared = 0，整个 protocol:check 退出码 0 全绿。
// 而字段级检查是唯一挡住「上游改字段名 → 运行时读到 undefined」的东西（见
// formatUnknownNotificationFields 自己的提示语：no throw, no failing test）。
//
// 【判据为什么是「全塌」而不是「每个类型都必须读出字段」】readTypeFields 返回 null 有两种
// 合法原因：类型文件不存在（真实协议里 SkillsChangedNotification 就是，93 个文件里没有它），
// 以及联合类型/别名没有顶层字段可比。2026-09-08 实测真实目录：71 个 params 类型 → 70 个读出。
// 要求 71/71 会当场误伤。锚在「声明了 N 个类型却一个都读不出」这个两侧对比上，不锚在绝对数字，
// 也不设会漂移的比例阈值。
test('通知字段用法对得上协议：字段解析全塌时必须红，不得报 OK', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-field-collapse-'));
  try {
    writeFileSync(join(dir, 'ServerNotification.ts'), [
      'export type ServerNotification =',
      '  | { "method": "turn/started", "params": TurnStartedNotification }',
      '  | { "method": "process/exited", "params": ProcessExitedNotification };',
    ].join('\n'));
    // 上游改用 interface 写法：method 侧照常解析得出，字段侧一个都读不出。
    writeFileSync(join(dir, 'TurnStartedNotification.ts'), 'export interface TurnStartedNotification { turnId: string }\n');
    writeFileSync(join(dir, 'ProcessExitedNotification.ts'), 'export interface ProcessExitedNotification { exitCode: number }\n');

    assert.equal(parseNotificationParamsTypes(readFileSync(join(dir, 'ServerNotification.ts'), 'utf8')).size, 2,
      'method → params 类型这一侧必须仍然正常，否则这条测的就不是字段侧塌陷了');
    assert.throws(
      () => readAllNotificationParamsFields(dir),
      /塌/,
      '声明了 params 类型却一个字段都读不出，是解析面塌了，不是「没有字段要查」',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 正对照：只断言「塌了要抛」的话，实现写成无条件 throw 也能过。这条钉住不该抛的那一侧。
test('通知字段用法对得上协议：只要读得出字段就不抛，个别类型缺文件属正常', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-field-partial-'));
  try {
    writeFileSync(join(dir, 'ServerNotification.ts'), [
      'export type ServerNotification =',
      '  | { "method": "turn/started", "params": TurnStartedNotification }',
      '  | { "method": "skills/changed", "params": SkillsChangedNotification };',
    ].join('\n'));
    writeFileSync(join(dir, 'TurnStartedNotification.ts'), 'export type TurnStartedNotification = { turnId: string };\n');
    // SkillsChangedNotification.ts 故意不写 —— 真实协议里就是这个形态。

    const declared = readAllNotificationParamsFields(dir);
    assert.equal(declared.size, 1, '读得出的那个要在，读不出的那个跳过');
    assert.deepEqual([...declared.get('TurnStartedNotification')], ['turnId']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 请求方向的 params 形态 ----
//
// 通知方向守的是「读了协议没有的字段」，这一族守的是它的镜像：**送了协议不接受的形态**。
// 实际出过的事：readAccount() 写成 this.request('account/read', undefined)，而协议里
// account/read 的 params 是 GetAccountParams。JSON.stringify 把值为 undefined 的键整个
// 丢掉，app-server 收到一帧没有 params 的请求，回 -32600 missing field `params`，
// 于是账号面板对所有人恒为错误态。mock、fake codex、e2e 断言三层都没红——假 server
// 不校验 params，e2e 的正则又把「无法读取」列进了通过条件。

test('请求 params 形态：从 ClientRequest 抽出每个 method 的 params 类型', () => {
  const source = 'export type ClientRequest ='
    + '{ "method": "account/read", id: RequestId, params: GetAccountParams, }'
    + ' | { "method": "account/logout", id: RequestId, params: undefined, };\n';

  const types = parseRequestParamsTypes(source);
  assert.equal(types.get('account/read'), 'GetAccountParams');
  assert.equal(types.get('account/logout'), 'undefined', '不带 params 的请求要能和结构体区分开');
});

test('请求 params 形态：只挑出省略 params 或写死 undefined 的调用点', () => {
  const source = `
    this.request('account/read', undefined);
    this.request('account/usage/read', undefined),
    this.request('config/read', { cwd: this.cwd });
    this.request('model/list', definedParams({ limit }));
    this.request('experimentalFeature/list');
    this.request('thread/start', startParams);
  `;

  const omitted = collectOmittedRequestParams(source);
  assert.deepEqual([...omitted].sort(), ['account/read', 'account/usage/read', 'experimentalFeature/list']);
});

test('请求 params 形态：协议要结构体才报，声明 undefined 的不报', () => {
  const paramsTypes = new Map([
    ['account/read', 'GetAccountParams'],
    ['account/usage/read', 'undefined'],
  ]);
  const omitted = new Set(['account/read', 'account/usage/read', 'thread/notInProtocol']);

  const problems = findOmittedRequiredParams({ omitted, paramsTypes });
  assert.deepEqual(problems, [{ method: 'account/read', paramsType: 'GetAccountParams' }],
    'usage/read 的 params 本就是 undefined；协议里没有的 method 交给 findMissingProtocolCoverage 报');
  assert.match(formatOmittedRequiredParams(problems), /GetAccountParams/);
  assert.match(formatOmittedRequiredParams([]), /OK/);
});

test('请求 params 形态：真实的 agent-appserver.js 对着真实协议没有缺 params 的请求', () => {
  const problems = findOmittedRequiredParams({
    omitted: collectOmittedRequestParams(readFileSync(join(root, 'src', 'agent', 'agent-appserver.js'), 'utf8')),
    paramsTypes: parseRequestParamsTypes(readFileSync(join(protocolDir, 'ClientRequest.ts'), 'utf8')),
  });

  assert.deepEqual(problems, [], formatOmittedRequiredParams(problems));
});

// ---- 对着已装版本跑 ----
//
// 上游稳定版的相邻间隔中位数是 1 天，pin 不可能追。于是本机装的 codex 通常比 pin 新，
// 而 checkCodexBinary 的硬版本比对会让 protocol:check 在本地直接拒跑——结果是这道门禁
// 只有 CI 跑得动，而 CI 装的正是 pin 的那一版。中间那些版本没有任何东西在看。
//
// --against-installed 补的就是这段盲区：基线仍是 .protocol/stable，但允许对着本机那版
// 比一遍。此时协议文件必然大面积 diff（0.147.0 → 0.153.4 实测 122 个文件），那是预期
// 的信息，不是失败；真正说明「桥会坏」的是另外三项。

test('对着已装版本跑：协议文件漂移是信息，不是失败', () => {
  const base = { missing: [], unknownFields: [], omittedParams: [] };

  assert.equal(protocolCheckFailed({ ...base, drifted: true, againstInstalled: true }), false,
    '对着比 pin 新的版本比，文件当然会漂——把它算成失败这个模式就没法用了');
  assert.equal(protocolCheckFailed({ ...base, drifted: true, againstInstalled: false }), true,
    '严格模式（CI 装的就是 pin）下漂移仍然是硬失败，这一侧不能退化');
});

test('对着已装版本跑：桥会坏的那三项仍然是失败', () => {
  const base = { drifted: false, missing: [], unknownFields: [], omittedParams: [], againstInstalled: true };

  for (const key of ['missing', 'unknownFields', 'omittedParams']) {
    assert.equal(protocolCheckFailed({ ...base, [key]: [{ method: 'x' }] }), true,
      `${key} 非空说明桥在这一版上会坏，正是这个模式要报的东西`);
  }
  assert.equal(protocolCheckFailed(base), false, '四项都干净才算通过');
});

test('protocol check CLI：--against-installed 下版本比 pin 新也照跑，并标明两个版本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-cli-installed-'));
  const pinned = readFileSync(join(root, '.codex-version'), 'utf8').trim();
  const newer = '9.99.9';
  try {
    const fakeBin = join(dir, 'bin');
    const fakeCodex = join(fakeBin, 'codex');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeCodex, [
      '#!/usr/bin/env node',
      "import { cpSync, rmSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const args = process.argv.slice(2);',
      `if (args[0] === '--version') { console.log('codex-cli ${newer}'); process.exit(0); }`,
      "if (args[0] === 'app-server' && args[1] === 'generate-ts') {",
      "  const out = args[args.indexOf('--out') + 1];",
      "  rmSync(out, { recursive: true, force: true });",
      "  cpSync(join(process.env.CCM_REPO_ROOT, '.protocol', 'stable'), out, { recursive: true });",
      '  process.exit(0);',
      '}',
      'process.exit(2);',
    ].join('\n'));
    chmodSync(fakeCodex, 0o755);
    const env = { ...process.env, CCM_REPO_ROOT: root, PATH: `${fakeBin}:${process.env.PATH}` };

    const relaxed = spawnSync(process.execPath, ['scripts/gates/protocol-check.mjs', '--against-installed'],
      { cwd: root, encoding: 'utf8', env });
    assert.equal(relaxed.status, 0, relaxed.stderr || relaxed.stdout);
    assert.match(relaxed.stdout, new RegExp(newer.replace(/\./g, '\\.')), '报告要说清这是对着哪一版跑的');
    assert.match(relaxed.stdout, new RegExp(pinned.replace(/\./g, '\\.')), 'pin 也要出现，否则读的人不知道基线是什么');

    // 正对照：默认模式下版本对不上仍然拒跑，严格性不因为新模式而松掉。
    const strict = spawnSync(process.execPath, ['scripts/gates/protocol-check.mjs'],
      { cwd: root, encoding: 'utf8', env });
    assert.notEqual(strict.status, 0, '默认模式必须仍然要求本机 codex 与 pin 一致');
    assert.match(strict.stderr, /does not match/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
