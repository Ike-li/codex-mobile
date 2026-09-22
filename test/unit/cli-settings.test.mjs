import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStringLiteralUnion } from '../../scripts/gates/protocol-check.mjs';
import {
  APPROVAL_OPTIONS,
  SANDBOX_OPTIONS,
  FALLBACK_REASONING_OPTIONS,
  visibleModels,
  reasoningOptionsForModel,
  serviceTiersForModel,
  normalizeReasoningEffort,
  normalizeApprovalPolicy,
  resolveSelectedModel,
  clampEffortForModel,
  clampServiceTierForModel,
  formatModelBadge,
  formatPermissionBadge,
  formatComposerMode,
  formatComposerPermission,
  formatComposerModel,
  formatComposerEffort,
  composerEffortVisible,
  normalizeCollaborationMode,
  collaborationModePayload,
  collaborationModeFromThreadSettings,
  isUnsupportedCollaborationModeError,
  parseCollaborationModeSlash,
  sanitizeTurnOverrides,
  modelAcceptsImages,
  GRANULAR_APPROVAL_KEYS,
  sandboxPolicyFromMode,
  buildTurnStartOverrides,
  effectiveComposerSettings,
  loadCliSettings,
  saveCliSettings,
  SETTINGS_STORAGE_KEY,
} from '../../public/js/util/cli-settings.js';

// Derived from the pinned protocol rather than restated here: an option the
// protocol dropped would otherwise stay valid in the UI and get rejected only
// once app-server refuses the turn.
function protocolLiterals(relativePath, typeName) {
  const source = readFileSync(join(process.cwd(), '.protocol', 'stable', relativePath), 'utf8');
  return parseStringLiteralUnion(source, typeName);
}

test('approval options are accepted by the pinned AskForApproval', () => {
  const accepted = protocolLiterals(join('v2', 'AskForApproval.ts'), 'AskForApproval');
  for (const id of APPROVAL_OPTIONS.map(option => option.id)) {
    assert.ok(accepted.has(id), `approval option "${id}" is not in AskForApproval: ${[...accepted].join(' | ')}`);
  }
});

test('sandbox options are accepted by the pinned SandboxMode', () => {
  const accepted = protocolLiterals(join('v2', 'SandboxMode.ts'), 'SandboxMode');
  for (const id of SANDBOX_OPTIONS.map(option => option.id)) {
    assert.ok(accepted.has(id), `sandbox option "${id}" is not in SandboxMode: ${[...accepted].join(' | ')}`);
  }
});

test('fallback reasoning options match the Codex CLI effort enum', () => {
  assert.deepEqual(FALLBACK_REASONING_OPTIONS.map(option => option.id), [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
  ]);
});

test('visible models hide catalog entries marked hidden', () => {
  const models = visibleModels([
    { model: 'gpt-5.6-sol', displayName: 'GPT-5.6', hidden: false },
    { model: 'secret-lab', displayName: 'Lab', hidden: true },
    { model: 'gpt-5.4', displayName: 'GPT-5.4' },
  ]);
  assert.deepEqual(models.map(model => model.model), ['gpt-5.6-sol', 'gpt-5.4']);
});

test('reasoning options come from the selected model and fall back to the CLI enum', () => {
  const fromModel = reasoningOptionsForModel({
    model: 'gpt-5.6-sol',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Faster' },
      { reasoningEffort: 'high', description: 'Deeper' },
      { reasoningEffort: 'max', description: 'Maximum' },
    ],
  });
  assert.deepEqual(fromModel.map(option => option.id), ['low', 'high', 'max']);
  assert.equal(fromModel[1].desc, 'Deeper');

  const fallback = reasoningOptionsForModel({ model: 'unknown' });
  assert.deepEqual(
    fallback.map(option => option.id),
    FALLBACK_REASONING_OPTIONS.map(option => option.id),
  );
});

test('legacy Chinese and alias labels normalize to CLI protocol ids', () => {
  assert.equal(normalizeReasoningEffort('超高'), 'xhigh');
  assert.equal(normalizeReasoningEffort('低'), 'low');
  assert.equal(normalizeReasoningEffort('中'), 'medium');
  assert.equal(normalizeReasoningEffort('高'), 'high');
  assert.equal(normalizeReasoningEffort('Ultra'), 'ultra');
  assert.equal(normalizeReasoningEffort('MAX'), 'max');
  assert.equal(normalizeApprovalPolicy('unlessTrusted'), 'untrusted');
  assert.equal(normalizeApprovalPolicy('custom'), 'on-request');
  assert.equal(normalizeApprovalPolicy('never'), 'never');
});

test('selected model prefers a stored catalog hit, then default, then a free-form CLI id', () => {
  const models = [
    { model: 'gpt-5.4', displayName: 'GPT-5.4', isDefault: false },
    { model: 'gpt-5.6-sol', displayName: 'GPT-5.6', isDefault: true },
  ];
  assert.equal(resolveSelectedModel('gpt-5.4', models), 'gpt-5.4');
  assert.equal(resolveSelectedModel('gpt-5.5', models), 'gpt-5.6-sol');
  assert.equal(resolveSelectedModel('my-local-oss', models), 'my-local-oss');
  assert.equal(resolveSelectedModel('', models), 'gpt-5.6-sol');
});

test('effort is clamped to the selected model and service tiers come from the catalog', () => {
  const model = {
    model: 'gpt-5.6-sol',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'high' },
    ],
    defaultReasoningEffort: 'high',
    serviceTiers: [
      { id: 'standard', name: 'Standard' },
      { id: 'fast', name: 'Fast' },
    ],
    defaultServiceTier: 'standard',
  };
  assert.equal(clampEffortForModel('max', model), 'high');
  assert.equal(clampEffortForModel('low', model), 'low');
  assert.deepEqual(serviceTiersForModel(model).map(tier => tier.id), ['standard', 'fast']);
  assert.deepEqual(serviceTiersForModel({}), []);
});

test('an unset service tier falls back to the default row instead of inventing Fast', () => {
  const model = {
    serviceTiers: [
      { name: 'Fast', description: '1.5x speed, increased usage', serviceTier: 'priority' },
      { id: 'standard', name: 'Standard', description: 'Default speed' },
    ],
    defaultServiceTier: 'standard',
  };
  assert.deepEqual(serviceTiersForModel(model).map(tier => tier.id), ['priority', 'standard']);
  // 没选过、或选了个这个模型不认的值，都落到它自己声明的默认档——和思考强度一个待遇，
  // 这样面板里总有一行是勾上的。但绝不能顺手升到收费的加速档。
  assert.equal(clampServiceTierForModel('', model), 'standard');
  assert.equal(clampServiceTierForModel('fast', model), 'standard');
  assert.equal(clampServiceTierForModel('priority', model), 'priority');
  assert.equal(clampServiceTierForModel('standard', model), 'standard');
  // 默认档没声明时退到首项，仍然不是加速档。
  assert.equal(
    clampServiceTierForModel('', {
      serviceTiers: [{ id: 'standard', name: 'Standard' }, { id: 'fast', name: 'Fast' }],
    }),
    'standard',
  );
});

test('a model that only advertises Fast still gets an explicit default row', () => {
  // 真实 Codex 的 serviceTiers 里只有 fast，"标准"是隐式的 null 态。照数组直传的话
  // 面板里就只剩孤零零一个 Fast：看不出自己在哪一档，也没有可见的回退路径。
  // 对齐桌面端——默认档补成显式一项，排在首位，id 为空表示不下发 serviceTier。
  const model = {
    serviceTiers: [{ id: 'fast', name: 'Fast', description: '1.5x speed, increased usage' }],
    defaultServiceTier: 'standard',
  };
  const tiers = serviceTiersForModel(model);
  assert.deepEqual(tiers.map(tier => tier.id), ['', 'fast']);
  assert.equal(tiers[0].name, '标准');
  assert.equal(tiers[0].description, '默认速度');
  assert.equal(clampServiceTierForModel('', model), '');

  // 上游自己给了默认档就不能再补一条重复的。
  assert.deepEqual(
    serviceTiersForModel({
      serviceTiers: [{ id: 'standard', name: 'Standard' }, { id: 'fast', name: 'Fast' }],
      defaultServiceTier: 'standard',
    }).map(tier => tier.id),
    ['standard', 'fast'],
  );
  // defaultServiceTier 缺失时也认 standard 这个约定 id。
  assert.deepEqual(
    serviceTiersForModel({
      serviceTiers: [{ id: 'standard', name: 'Standard' }, { id: 'fast', name: 'Fast' }],
    }).map(tier => tier.id),
    ['standard', 'fast'],
  );
  // 模型完全不支持档位时整组仍然不显示。
  assert.deepEqual(serviceTiersForModel({}), []);
  assert.deepEqual(serviceTiersForModel({ serviceTiers: [] }), []);
});

test('service tier labels fall back to upstream text when the id or wording is unknown', () => {
  // 硬编码中文有过期风险：上游哪天把 1.5x 改成 2x，我们不能继续显示旧数字。
  const tiers = serviceTiersForModel({
    serviceTiers: [
      { id: 'standard', name: 'Standard', description: 'Default speed' },
      { id: 'fast', name: 'Fast', description: '1.5x speed, increased usage' },
      { id: 'priority', name: 'Priority', description: 'Reserved capacity' },
    ],
    defaultServiceTier: 'standard',
  });
  assert.equal(tiers[0].name, '标准');
  assert.equal(tiers[0].description, '默认速度');
  assert.equal(tiers[1].name, '快速');
  assert.equal(tiers[1].description, '1.5 倍速度，用量更多');
  assert.equal(tiers[2].name, 'Priority', '没见过的档位 id 整条透传');
  assert.equal(tiers[2].description, 'Reserved capacity');

  const reworded = serviceTiersForModel({
    serviceTiers: [{ id: 'fast', name: 'Fast', description: '2x speed, increased usage' }],
  });
  assert.equal(reworded[1].name, '快速');
  assert.equal(
    reworded[1].description,
    '2x speed, increased usage',
    '没见过的措辞照原文显示，不要拿旧倍数糊弄',
  );
});

test('empty settings do not invent CLI overrides that would clobber config.toml', () => {
  assert.deepEqual(sanitizeTurnOverrides({}), {});
  assert.deepEqual(buildTurnStartOverrides({}), {});
  // badge 保持纯字符串:图标只出现在 popover/消息流 SVG 槽,不塞进文本节点。
  assert.equal(formatPermissionBadge({}), '配置默认');
  assert.equal(formatModelBadge({}), '');
});

test('badges show CLI-faithful model, effort, approval and sandbox labels', () => {
  assert.equal(
    formatModelBadge({ model: 'gpt-5.6-sol', effort: 'max', displayName: 'GPT-5.6' }),
    'GPT-5.6 最大',
  );
  assert.equal(
    formatModelBadge({ model: 'gpt-5.4-mini', effort: 'high', serviceTier: 'fast' }),
    '5.4-mini 高 · 加速',
  );
  assert.equal(
    formatPermissionBadge({ approvalPolicy: 'on-request', sandbox: 'workspace-write' }),
    '按请求批准 · 工作区可写',
  );
  assert.equal(
    formatPermissionBadge({ approvalPolicy: 'never', sandbox: 'danger-full-access' }),
    '从不询问 · 完全访问',
  );
});

test('composer chips use short labels that will not wrap on a phone toolbar', () => {
  assert.equal(formatComposerMode('default'), '对话');
  assert.equal(formatComposerMode('plan'), '计划');
  assert.equal(formatComposerMode('/chat'), '对话');
  assert.equal(formatComposerMode('/plan'), '计划');
  assert.equal(
    formatComposerPermission({ approvalPolicy: 'on-request', sandbox: 'workspace-write' }),
    '按请求 · 可写',
  );
  assert.equal(
    formatComposerPermission({ approvalPolicy: 'never', sandbox: 'danger-full-access' }),
    '不问 · 全开',
  );
  assert.equal(formatComposerPermission({}), '默认');
  assert.equal(formatComposerModel({ displayName: 'GPT-5.6-Sol', effort: 'max' }), 'GPT-5.6-Sol');
  assert.equal(formatComposerModel({ model: 'gpt-5.4-mini' }), '5.4-mini');
  assert.equal(formatComposerModel({}), '');
  assert.equal(formatComposerModel({ model: '   ' }), '');
  assert.equal(formatComposerEffort('max'), '最大');
  assert.equal(formatComposerEffort(''), '');
  assert.equal(composerEffortVisible('medium', { defaultReasoningEffort: 'medium' }), false);
  assert.equal(composerEffortVisible('high', { defaultReasoningEffort: 'medium' }), true);
  assert.equal(composerEffortVisible('medium', {}), false);
  for (const label of [
    formatComposerMode('default'),
    formatComposerPermission({ approvalPolicy: 'on-request', sandbox: 'workspace-write' }),
    formatComposerModel({ displayName: 'GPT-5.6-Sol' }),
  ]) {
    assert.equal(/\p{Extended_Pictographic}/u.test(label), false);
    assert.ok(label.length <= 12, `${label} is too long for the composer chip`);
  }
});

test('turn overrides map CLI sandbox modes onto turn/start sandboxPolicy objects', () => {
  assert.deepEqual(
    sanitizeTurnOverrides({
      model: 'gpt-5.6-sol',
      effort: '超高',
      approvalPolicy: 'unlessTrusted',
      sandbox: 'workspace-write',
      serviceTier: 'fast',
      extra: 'drop-me',
    }),
    {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      serviceTier: 'fast',
    },
  );
  assert.equal(sanitizeTurnOverrides({ approvalPolicy: 'nope', sandbox: 'jailbreak' }).approvalPolicy, undefined);
  assert.deepEqual(sandboxPolicyFromMode('read-only'), { type: 'readOnly', networkAccess: false });
  assert.deepEqual(sandboxPolicyFromMode('danger-full-access'), { type: 'dangerFullAccess' });
  assert.deepEqual(sandboxPolicyFromMode('workspace-write'), {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
  assert.deepEqual(
    buildTurnStartOverrides({
      model: 'gpt-5.6-sol',
      effort: 'max',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      serviceTier: 'fast',
    }),
    {
      model: 'gpt-5.6-sol',
      effort: 'max',
      approvalPolicy: 'never',
      serviceTier: 'fast',
      sandboxPolicy: { type: 'dangerFullAccess' },
    },
  );
});

test('collaboration mode uses protocol ids and is applied as a turn override, not a slash message', () => {
  assert.equal(normalizeCollaborationMode('plan'), 'plan');
  assert.equal(normalizeCollaborationMode('default'), 'default');
  assert.equal(normalizeCollaborationMode('/plan'), 'plan');
  assert.equal(normalizeCollaborationMode('/chat'), 'default');
  assert.equal(normalizeCollaborationMode('nope'), '');
  assert.deepEqual(sanitizeTurnOverrides({ collaborationMode: '/plan' }), { collaborationMode: 'plan' });
  assert.deepEqual(sanitizeTurnOverrides({ collaborationMode: 'default' }), { collaborationMode: 'default' });
  assert.equal(sanitizeTurnOverrides({ collaborationMode: 'pair' }).collaborationMode, undefined);
  // collaborationMode 属于 ThreadSettings，走 thread/settings/update；TurnStartParams
  // 的协议契约（.protocol/stable/v2/TurnStartParams.ts）里没有这个字段。带上它会让
  // app-server 整体反序列化失败，并回报一个指向别处的 `missing field \`model\``。
  assert.equal(buildTurnStartOverrides({ collaborationMode: 'plan' }).collaborationMode, undefined);
  assert.ok(!('collaborationMode' in buildTurnStartOverrides({ collaborationMode: 'plan' })));
  // 仍要保留在 sanitize 结果里：网关用它记住当前模式并发 thread/settings/update。
  assert.equal(sanitizeTurnOverrides({ collaborationMode: 'plan' }).collaborationMode, 'plan');
  // 其余 override 不受影响，model 必须照常带出去。
  assert.equal(buildTurnStartOverrides({ model: 'gpt-5.4', collaborationMode: 'plan' }).model, 'gpt-5.4');
  assert.deepEqual(collaborationModePayload('plan'), {
    mode: 'plan',
    settings: { developer_instructions: null },
  });
  assert.equal(collaborationModePayload('pair'), null);
  assert.equal(collaborationModeFromThreadSettings({
    collaborationMode: { mode: 'plan', settings: { developer_instructions: null } },
  }), 'plan');
  assert.equal(collaborationModeFromThreadSettings({ collaborationMode: { mode: 'default' } }), 'default');
  assert.equal(collaborationModeFromThreadSettings({}), '');
  assert.equal(isUnsupportedCollaborationModeError({ code: -32601, message: 'Method not found' }), true);
  assert.equal(isUnsupportedCollaborationModeError({
    message: 'thread/settings/update requires experimentalApi capability',
  }), true);
  assert.equal(isUnsupportedCollaborationModeError({ code: -32602, message: 'invalid params' }), false);
  assert.deepEqual(parseCollaborationModeSlash('/plan'), { mode: 'plan', rest: '' });
  assert.deepEqual(parseCollaborationModeSlash('/plan 先列步骤'), { mode: 'plan', rest: '先列步骤' });
  assert.deepEqual(parseCollaborationModeSlash('/chat'), { mode: 'default', rest: '' });
  assert.equal(parseCollaborationModeSlash('/status'), null);
});

test('browser settings migrate old slash-label keys into CLI protocol ids', () => {
  const data = Object.create(null);
  const storage = {
    getItem: key => Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null,
    setItem: (key, value) => { data[key] = String(value); },
  };
  storage.setItem('codex_selected_model', 'gpt-5.5');
  storage.setItem('codex_selected_reasoning', '超高');
  storage.setItem('codex_selected_speed', '快速');
  const migrated = loadCliSettings(storage);
  assert.deepEqual(migrated, {
    model: 'gpt-5.5',
    effort: 'xhigh',
    serviceTier: 'fast',
  });

  saveCliSettings(storage, {
    model: 'gpt-5.6-sol',
    effort: 'max',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
  assert.equal(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)).model, 'gpt-5.6-sol');
  assert.deepEqual(loadCliSettings(storage), {
    model: 'gpt-5.6-sol',
    effort: 'max',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
});

// 曾经的缺陷：胶囊文案和模型列表都带服务端 fallback（`selectedApproval || sessionStatus?.approvalPolicy`、
// `selectedModel || resolveSelectedModel(...)`），但列表选中态和真正发出去的 turn override 用的是
// 裸的 selected*。于是界面显示「GPT-5.5 · 按请求 · 可写」，turn/start 却一个字段都不带，
// app-server 回落到自己的默认模型并回 400；审批/沙箱列表则一项 .selected 都没有。
// 这个函数是唯一事实源：显示什么，就发什么。
test('effective composer settings fill server defaults so the UI and the wire agree', () => {
  const models = [
    { model: 'gpt-5.5', isDefault: true },
    { model: 'gpt-5.4' },
  ];
  const status = { approvalPolicy: 'on-request', sandbox: 'workspace-write' };

  // 用户一次都没选过：三项都必须回落到服务端/模型列表的权威值，不能是空串。
  const fresh = effectiveComposerSettings({}, { status, models });
  assert.equal(fresh.model, 'gpt-5.5');
  assert.equal(fresh.approvalPolicy, 'on-request');
  assert.equal(fresh.sandbox, 'workspace-write');

  // 这份有效设置直接喂给 turn override，必须带出 model——这正是 400 的成因。
  assert.equal(buildTurnStartOverrides(fresh).model, 'gpt-5.5');
  assert.equal(buildTurnStartOverrides(fresh).approvalPolicy, 'on-request');

  // 用户显式选过就以用户为准，不被服务端默认覆盖。
  const picked = effectiveComposerSettings(
    { model: 'gpt-5.4', approvalPolicy: 'never', sandbox: 'read-only' },
    { status, models },
  );
  assert.equal(picked.model, 'gpt-5.4');
  assert.equal(picked.approvalPolicy, 'never');
  assert.equal(picked.sandbox, 'read-only');

  // 非法存值不能污染结果，回落到服务端值。
  const dirty = effectiveComposerSettings({ approvalPolicy: 'bogus', sandbox: 'nope' }, { status, models });
  assert.equal(dirty.approvalPolicy, 'on-request');
  assert.equal(dirty.sandbox, 'workspace-write');

  // 没有 status（还没连上）时不编造值，留空让服务端用自己的默认。
  const offline = effectiveComposerSettings({}, { status: null, models: [] });
  assert.equal(offline.approvalPolicy, '');
  assert.equal(offline.sandbox, '');
  assert.equal(offline.model, '');

  // collaborationMode 原样透传，不被这层动。
  // effort / serviceTier 则按所选模型的能力收敛：这两个 fixture 模型没声明任何服务档位，
  // 所以 'priority' 不该被透传出去——否则界面会显示一个该模型根本不存在的档位。
  const passthrough = effectiveComposerSettings(
    { effort: 'high', serviceTier: 'priority', collaborationMode: 'plan' },
    { status, models },
  );
  assert.equal(passthrough.collaborationMode, 'plan');
  assert.equal(passthrough.effort, 'high', '模型未声明支持列表时回落到通用档位，high 合法');
  assert.equal(passthrough.serviceTier, '', '模型不支持任何服务档位，不能透传非法值');
});

// thread/settings/update 不在 stable v2 协议里（protocol:check 把它列在实验白名单），
// 仓库里也没有它的 params 契约。实测 codex-cli 0.142.5 上，我们发的
// {threadId, collaborationMode} 一律被拒：`Invalid request: missing field \`model\``——
// 它要的是完整的 ThreadSettings，而 thread/read 并不返回 settings，我们无从构造。
// 这条路径因此必须走 deferred 降级，而不是把红错误抛给用户。
test('a partial thread/settings/update rejection counts as unsupported, not a hard failure', () => {
  assert.equal(isUnsupportedCollaborationModeError({
    code: -32600,
    message: 'Invalid request: missing field `model`',
  }), true);
  assert.equal(isUnsupportedCollaborationModeError({
    code: -32600,
    message: 'Invalid request: missing field `modelProvider`',
  }), true);

  // 既有的两种识别方式不能退化。
  assert.equal(isUnsupportedCollaborationModeError({ code: -32601 }), true);
  assert.equal(isUnsupportedCollaborationModeError({ message: 'experimentalApi required' }), true);

  // 不能把无关失败一并吞掉：只有 Invalid request(-32600) + 缺字段 才算形态不被接受。
  assert.equal(isUnsupportedCollaborationModeError({ code: -32000, message: 'runtime exploded' }), false);
  assert.equal(isUnsupportedCollaborationModeError({ code: -32600, message: 'Invalid request: bad cwd' }), false);
  assert.equal(isUnsupportedCollaborationModeError(null), false);
});

// 同一个缺陷的第二半：effectiveComposerSettings 当初只补了 model / approvalPolicy /
// sandbox，漏了 effort 与 serviceTier。结果设置面板里前三组都有勾，思考强度和服务档位
// 却一个选中都没有——和修复前的 approval/sandbox 一模一样。
test('effective settings also fill reasoning effort and service tier', () => {
  const models = [{
    model: 'gpt-5.6',
    isDefault: true,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' },
    ],
    serviceTiers: [{ id: 'standard', name: 'Standard' }, { id: 'fast', name: 'Fast' }],
  }];
  const status = { approvalPolicy: 'on-request', sandbox: 'read-only' };

  // 没选过：回落到该模型自己的默认档，而不是留空让界面一个勾都没有。
  const fresh = effectiveComposerSettings({}, { status, models });
  assert.equal(fresh.effort, 'medium');

  // 选过就以用户为准。
  assert.equal(effectiveComposerSettings({ effort: 'high' }, { status, models }).effort, 'high');

  // 选了该模型不支持的档位，要收敛回合法值，不能把非法值透传给界面。
  assert.equal(effectiveComposerSettings({ effort: 'xhigh' }, { status, models }).effort, 'medium');

  // 服务档位：模型支持时才可能有值；用户选过且合法就保留。
  assert.equal(effectiveComposerSettings({ serviceTier: 'fast' }, { status, models }).serviceTier, 'fast');
  assert.equal(effectiveComposerSettings({ serviceTier: 'bogus' }, { status, models }).serviceTier, 'standard');
  assert.equal(effectiveComposerSettings({}, { status, models }).serviceTier, 'standard');

  // 模型不支持服务档位时，不能凭空造一个出来。
  const noTiers = [{ model: 'gpt-5.4', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }];
  assert.equal(effectiveComposerSettings({}, { status, models: noTiers }).serviceTier, '');

  // 还没连上、拿不到模型列表时不编造——与 approvalPolicy / sandbox 的处理保持一致。
  const offline = effectiveComposerSettings({}, { status: null, models: [] });
  assert.equal(offline.effort, '');
  assert.equal(offline.serviceTier, '');
});

// R-10：附件入口要按当前模型声明的输入模态启用或禁用，不能让用户传完了才失败。
// 模态未知时放行——协议里 inputModalities 是可选的，缺失不等于不支持，宁可让用户试一次
// 也不该凭空禁掉一个可能可用的功能。
test('附件入口按模型的 inputModalities 门控', () => {
  assert.equal(modelAcceptsImages({ inputModalities: ['text', 'image'] }), true);
  assert.equal(modelAcceptsImages({ inputModalities: ['text'] }), false);
  assert.equal(modelAcceptsImages({ inputModalities: [] }), true, '空数组视为未声明');
  assert.equal(modelAcceptsImages({}), true, '未声明时放行');
  assert.equal(modelAcceptsImages(null), true);
});

// 0.147.0 的 AskForApproval 除三个字符串档外还有一个对象变体 granular，含五个独立开关。
// 它不是第四个「档位」——放进 APPROVAL_OPTIONS 会让「每个选项都必须是协议里的字符串字面量」
// 这条漂移断言失效。所以单独建模：档位仍是三个字符串，细粒度是一组独立开关，选中时整体
// 替换 approvalPolicy。
test('细粒度审批开关的键与协议 granular 完全一致', () => {
  const source = readFileSync(join(process.cwd(), '.protocol', 'stable', 'v2', 'AskForApproval.ts'), 'utf8');
  const protocolKeys = [...source.matchAll(/(\w+):\s*boolean/g)].map(match => match[1]).sort();
  assert.deepEqual(GRANULAR_APPROVAL_KEYS.map(item => item.id).sort(), protocolKeys,
    '多一个或少一个键，app-server 都会拒掉整个 turn');
});

test('选中细粒度审批时下发协议的对象形态', () => {
  const flags = { sandbox_approval: true, rules: false, skill_approval: true, request_permissions: false, mcp_elicitations: true };
  const out = sanitizeTurnOverrides({ approvalPolicy: 'on-request', granularApproval: flags });
  assert.deepEqual(out.approvalPolicy, { granular: flags }, '细粒度优先于字符串档');

  // 五个键必须齐全：协议的对象变体没有可选字段。
  const partial = sanitizeTurnOverrides({ granularApproval: { sandbox_approval: true } });
  assert.equal(partial.approvalPolicy.granular.rules, false, '缺失的键补 false 而不是省略');
  assert.equal(Object.keys(partial.approvalPolicy.granular).length, 5);

  // 没开细粒度时行为不变。
  assert.equal(sanitizeTurnOverrides({ approvalPolicy: 'never' }).approvalPolicy, 'never');
});

test('session settings panel HTML contracts define compact grid layouts and necessary IDs', () => {
  const indexHtml = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');

  // 必须保留给 JS 绑定的各个容器 ID
  const requiredIds = [
    'session-settings',
    'session-settings-close',
    'session-settings-body',
    'approval-list',
    'granular-list',
    'permission-list',
    'settings-advanced',
    'reviewer-list',
    'permission-state',
    'permission-effective',
    'sandbox-list',
    'model-list',
    'reasoning-list',
    'speed-section-label',
    'speed-list',
  ];
  for (const id of requiredIds) {
    assert.ok(indexHtml.includes(`id="${id}"`), `public/index.html 缺少关键容器 id="${id}"`);
  }

  // 紧凑网格类名约定契约
  assert.doesNotMatch(indexHtml, /id="mode-list"/, '计划模式协议未通，会话设置里不放禁用占位');
  assert.match(indexHtml, /class="[^"]*settings-grid-3[^"]*" id="approval-list"/, '#approval-list 应当具备 settings-grid-3 紧凑三列布局类');
  assert.match(indexHtml, /class="[^"]*settings-grid-3[^"]*" id="sandbox-list"/, '#sandbox-list 应当具备 settings-grid-3 紧凑三列布局类');
  assert.match(indexHtml, /class="[^"]*settings-grid-2[^"]*" id="model-list"/, '#model-list 应当具备 settings-grid-2 紧凑双列布局类');
  assert.match(indexHtml, /class="[^"]*settings-wrap-row[^"]*" id="reasoning-list"/, '#reasoning-list 应当具备 settings-wrap-row 紧凑药丸流式布局类');

  // 常用项置顶顺序契约：模型 -> 思考强度 -> 审批策略依次排在最前
  const modelIdx = indexHtml.indexOf('id="model-list"');
  const reasoningIdx = indexHtml.indexOf('id="reasoning-list"');
  const approvalIdx = indexHtml.indexOf('id="approval-list"');
  assert.ok(modelIdx < reasoningIdx, '模型应排在思考强度之前');
  assert.ok(reasoningIdx < approvalIdx, '思考强度应排在审批策略之前');
});
