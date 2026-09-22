export const APPROVAL_OPTIONS = [
  {
    id: 'untrusted',
    title: '仅信任命令',
    desc: '只有 ls、cat 等信任命令自动执行；其余一律询问',
    iconName: 'shield',
  },
  {
    id: 'on-request',
    title: '按请求批准',
    desc: '模型决定何时向你申请批准',
    iconName: 'hand',
  },
  {
    id: 'never',
    title: '从不询问',
    desc: '不弹批准；失败立刻返回给模型',
    iconName: 'warning',
  },
];


// AskForApproval 的对象变体：五个独立开关，协议里没有可选字段，缺一个 app-server 就拒掉
// 整个 turn。它不是第四个「档位」——档位是三个字符串，这组开关选中时整体替换 approvalPolicy。
export const GRANULAR_APPROVAL_KEYS = [
  { id: 'sandbox_approval', title: '沙箱外操作', desc: '命令要越出沙箱时询问' },
  { id: 'rules', title: '规则匹配', desc: '命中审批规则时询问' },
  { id: 'skill_approval', title: '技能调用', desc: '调用 skill 时询问' },
  { id: 'request_permissions', title: '权限申请', desc: '模型主动申请权限时询问' },
  { id: 'mcp_elicitations', title: 'MCP 追问', desc: 'MCP 服务器要求补充信息时询问' },
];

export function granularApprovalPolicy(flags) {
  if (!flags || typeof flags !== 'object') return null;
  const granular = {};
  for (const { id } of GRANULAR_APPROVAL_KEYS) granular[id] = flags[id] === true;
  return { granular };
}

export const SANDBOX_OPTIONS = [
  {
    id: 'read-only',
    title: '只读',
    desc: '命令不能改文件',
    iconName: 'eye',
  },
  {
    id: 'workspace-write',
    title: '工作区可写',
    desc: '只能改当前工作区',
    iconName: 'notepad',
  },
  {
    id: 'danger-full-access',
    title: '完全访问',
    desc: '不沙箱，可访问本机任意文件',
    iconName: 'skull',
  },
];

export const FALLBACK_REASONING_OPTIONS = [
  { id: 'none', title: '关闭', desc: '不使用推理' },
  { id: 'minimal', title: '最低', desc: '尽量少想' },
  { id: 'low', title: '低' },
  { id: 'medium', title: '中' },
  { id: 'high', title: '高' },
  { id: 'xhigh', title: '超高' },
  { id: 'max', title: '最大' },
  { id: 'ultra', title: 'Ultra' },
];

const FALLBACK_REASONING_BY_ID = new Map(
  FALLBACK_REASONING_OPTIONS.map(option => [option.id, option]),
);

export function visibleModels(models = []) {
  if (!Array.isArray(models)) return [];
  return models.filter(model => model && model.hidden !== true && (model.model || model.id));
}

export function reasoningOptionsForModel(model) {
  const listed = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
      .map(option => {
        const id = option?.reasoningEffort || option?.id;
        if (!id) return null;
        const known = FALLBACK_REASONING_BY_ID.get(id);
        return {
          id,
          title: known?.title || id,
          desc: option.description || known?.desc || '',
        };
      })
      .filter(Boolean)
    : [];
  return listed.length ? listed : FALLBACK_REASONING_OPTIONS.slice();
}

const LEGACY_HARDCODED_MODELS = new Set(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
const APPROVAL_IDS = new Set(APPROVAL_OPTIONS.map(option => option.id));
const SANDBOX_IDS = new Set(SANDBOX_OPTIONS.map(option => option.id));
const APPROVAL_ALIASES = {
  unlesstrusted: 'untrusted',
  custom: 'on-request',
};
const REASONING_ALIASES = {
  关闭: 'none',
  最低: 'minimal',
  低: 'low',
  中: 'medium',
  高: 'high',
  超高: 'xhigh',
  最大: 'max',
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra',
};

function optionById(options, id) {
  return options.find(option => option.id === id) || null;
}

function modelId(model) {
  return model?.model || model?.id || '';
}

export function serviceTierId(tier) {
  if (!tier || typeof tier !== 'object') return '';
  for (const key of ['id', 'serviceTier']) {
    const value = tier[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

// 上游按 en 返回档位文案。只翻译认识的 id 和认识的原句，其余整条透传——
// 上游哪天把 1.5x 改成别的倍数，宁可显示英文原文，也不能拿旧数字糊弄用户。
const SERVICE_TIER_NAMES = {
  standard: '标准',
  fast: '快速',
};

const SERVICE_TIER_DESCRIPTIONS = {
  'default speed': '默认速度',
  '1.5x speed, increased usage': '1.5 倍速度，用量更多',
};

const STANDARD_SERVICE_TIER_ID = 'standard';

function localizeServiceTier(tier) {
  const description = SERVICE_TIER_DESCRIPTIONS[tier.description.trim().toLowerCase()];
  return {
    ...tier,
    name: SERVICE_TIER_NAMES[tier.id] || tier.name,
    description: description || tier.description,
  };
}

export function serviceTiersForModel(model) {
  if (!Array.isArray(model?.serviceTiers)) return [];
  const listed = model.serviceTiers.flatMap(tier => {
    if (!tier) return [];
    const id = serviceTierId(tier);
    const name = typeof tier.name === 'string' ? tier.name.trim() : '';
    if (!id) return [];
    return [{
      ...tier,
      id,
      name: name || id,
      description: typeof tier.description === 'string' ? tier.description : '',
    }];
  }).map(localizeServiceTier);
  if (!listed.length) return [];
  const defaultId = typeof model.defaultServiceTier === 'string' ? model.defaultServiceTier.trim() : '';
  if (listed.some(tier => tier.id === (defaultId || STANDARD_SERVICE_TIER_ID))) return listed;
  // 上游只列了加速档时，"标准"是它隐式的未设置态。补成显式一项排在首位，
  // 否则用户既看不出自己在哪一档，也没有回到默认的入口。空 id = 不下发 serviceTier。
  return [{
    id: '',
    name: SERVICE_TIER_NAMES[STANDARD_SERVICE_TIER_ID],
    description: SERVICE_TIER_DESCRIPTIONS['default speed'],
  }, ...listed];
}

export function normalizeReasoningEffort(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const alias = REASONING_ALIASES[trimmed] || REASONING_ALIASES[trimmed.toLowerCase()];
  return alias || trimmed;
}

export function normalizeApprovalPolicy(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const alias = APPROVAL_ALIASES[trimmed.toLowerCase()] || trimmed;
  return APPROVAL_IDS.has(alias) ? alias : '';
}

export function normalizeSandbox(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return SANDBOX_IDS.has(trimmed) ? trimmed : '';
}

export function resolveSelectedModel(stored, models = []) {
  const visible = visibleModels(models);
  const storedId = typeof stored === 'string' ? stored.trim() : '';
  if (storedId && visible.some(model => modelId(model) === storedId)) return storedId;
  if (storedId && !LEGACY_HARDCODED_MODELS.has(storedId)) return storedId;
  const fallback = visible.find(model => model.isDefault) || visible[0];
  return modelId(fallback) || storedId || '';
}

export function clampEffortForModel(effort, model) {
  const options = reasoningOptionsForModel(model);
  const normalized = normalizeReasoningEffort(effort);
  if (normalized && options.some(option => option.id === normalized)) return normalized;
  const defaultEffort = normalizeReasoningEffort(model?.defaultReasoningEffort);
  if (defaultEffort && options.some(option => option.id === defaultEffort)) return defaultEffort;
  return options[0]?.id || '';
}

export function clampServiceTierForModel(tier, model) {
  const tiers = serviceTiersForModel(model);
  if (!tiers.length) return '';
  const normalized = typeof tier === 'string' ? tier.trim() : '';
  if (tiers.some(item => item.id === normalized)) return normalized;
  // 没选过或选了个这个模型不认的值时回落到默认档，跟 clampEffortForModel 一个待遇——
  // 留空会让「速度」这组一个勾都没有，用户看不出自己在哪一档。默认档一定不是加速档：
  // serviceTiersForModel 保证了 defaultServiceTier 在列表里，或首项是它补出来的标准档。
  const defaultId = typeof model?.defaultServiceTier === 'string' ? model.defaultServiceTier.trim() : '';
  if (defaultId && tiers.some(item => item.id === defaultId)) return defaultId;
  return tiers[0].id;
}

export function formatModelBadge({
  model = '',
  effort = '',
  serviceTier = '',
  displayName = '',
} = {}) {
  let name = displayName || model || '';
  if (!displayName && /^gpt-/i.test(name)) name = name.slice(4);
  const effortLabel = optionById(FALLBACK_REASONING_OPTIONS, normalizeReasoningEffort(effort))?.title
    || normalizeReasoningEffort(effort);
  const speed = serviceTier && serviceTier !== 'standard' ? ' · 加速' : '';
  return [name, effortLabel].filter(Boolean).join(' ') + speed;
}

export function formatPermissionBadge({
  approvalPolicy = '',
  sandbox = '',
} = {}) {
  const approvalId = normalizeApprovalPolicy(approvalPolicy);
  const sandboxId = normalizeSandbox(sandbox);
  // 纯文案:popover 才用 SVG。字符串里塞 emoji/SVG 都会在文本节点里穿帮。
  if (!approvalId && !sandboxId) return '配置默认';
  const approval = optionById(APPROVAL_OPTIONS, approvalId);
  const sandboxOption = optionById(SANDBOX_OPTIONS, sandboxId);
  const left = approval ? approval.title : (approvalPolicy || '审批默认');
  const right = sandboxOption?.title || sandbox || '沙箱默认';
  return `${left} · ${right}`.trim();
}

const COMPOSER_APPROVAL = {
  untrusted: '仅信任',
  'on-request': '按请求',
  never: '不问',
};

const COMPOSER_SANDBOX = {
  'read-only': '只读',
  'workspace-write': '可写',
  'danger-full-access': '全开',
};

const COLLABORATION_MODE_IDS = new Set(['default', 'plan']);
const COLLABORATION_MODE_ALIASES = {
  '/chat': 'default',
  chat: 'default',
  default: 'default',
  '/plan': 'plan',
  plan: 'plan',
};

export function normalizeCollaborationMode(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const alias = COLLABORATION_MODE_ALIASES[trimmed] || COLLABORATION_MODE_ALIASES[trimmed.toLowerCase()];
  return COLLABORATION_MODE_IDS.has(alias) ? alias : '';
}

export function formatComposerMode(mode) {
  return normalizeCollaborationMode(mode) === 'plan' ? '计划' : '对话';
}

export function collaborationModePayload(mode) {
  const normalized = normalizeCollaborationMode(mode);
  if (!normalized) return null;
  return {
    mode: normalized,
    settings: { developer_instructions: null },
  };
}

export function collaborationModeFromThreadSettings(threadSettings) {
  return normalizeCollaborationMode(threadSettings?.collaborationMode?.mode);
}

export function isUnsupportedCollaborationModeError(error) {
  if (!error) return false;
  if (error.code === -32601) return true;
  const message = String(error.message || error);
  if (/experimentalApi/i.test(message) || /thread\/settings\/update/i.test(message)) return true;
  // thread/settings/update 不在 stable v2 里，仓库也没有它的 params 契约。实测
  // codex-cli 0.142.5 要的是完整 ThreadSettings，而 thread/read 不返回 settings，
  // 我们构造不出来——它只会回 `Invalid request: missing field \`model\``。把这种
  // 「参数形态不被接受」判成不支持，走 deferred 降级；其余 Invalid request 仍然抛出，
  // 免得把真正的调用错误一起吞掉。
  return error.code === -32600 && /missing field/i.test(message);
}

export function parseCollaborationModeSlash(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  const match = raw.match(/^\/(plan|chat)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return {
    mode: match[1].toLowerCase() === 'plan' ? 'plan' : 'default',
    rest: (match[2] || '').trim(),
  };
}

export function formatComposerPermission({
  approvalPolicy = '',
  sandbox = '',
} = {}) {
  const approvalId = normalizeApprovalPolicy(approvalPolicy);
  const sandboxId = normalizeSandbox(sandbox);
  if (!approvalId && !sandboxId) return '默认';
  const left = COMPOSER_APPROVAL[approvalId] || '审批';
  const right = COMPOSER_SANDBOX[sandboxId] || '';
  return right ? `${left} · ${right}` : left;
}

export function formatComposerModel({
  model = '',
  displayName = '',
} = {}) {
  let name = String(displayName || model || '').trim();
  if (!displayName && /^gpt-/i.test(name)) name = name.slice(4);
  return name;
}

export function formatComposerEffort(effort) {
  const id = normalizeReasoningEffort(effort);
  if (!id) return '';
  return optionById(FALLBACK_REASONING_OPTIONS, id)?.title || '';
}

export function composerEffortVisible(effort, model) {
  const id = normalizeReasoningEffort(effort);
  if (!id) return false;
  const defaultEffort = normalizeReasoningEffort(model?.defaultReasoningEffort);
  if (!defaultEffort) return false;
  return id !== defaultEffort;
}

export const PERMISSION_PRESETS = Object.freeze({
  ask: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' },
  'auto-review': { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' },
  'full-access': { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' },
});

export function permissionModeForSettings(settings = {}) {
  if (settings.permission?.mode) return settings.permission.mode;
  for (const [mode, preset] of Object.entries(PERMISSION_PRESETS)) {
    if (settings.approvalPolicy === preset.approvalPolicy && settings.sandbox === preset.sandbox
      && (settings.approvalsReviewer || 'user') === preset.approvalsReviewer) return mode;
  }
  return settings.approvalPolicy || settings.sandbox ? 'custom' : 'ask';
}

export function sanitizeTurnOverrides(input = {}) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  if (typeof input.model === 'string' && input.model.trim()) out.model = input.model.trim();
  const effort = normalizeReasoningEffort(input.effort);
  if (effort) out.effort = effort;
  // 细粒度优先：它一旦开启，三个字符串档就不再适用——协议的 approvalPolicy 是联合类型，
  // 同一个字段只能是其中一种形态。
  const granular = granularApprovalPolicy(input.granularApproval || input.approvalPolicy?.granular);
  const approvalPolicy = normalizeApprovalPolicy(input.approvalPolicy);
  if (granular) out.approvalPolicy = granular;
  else if (approvalPolicy) out.approvalPolicy = approvalPolicy;
  const sandbox = normalizeSandbox(input.sandbox);
  if (sandbox) out.sandbox = sandbox;
  if (['user', 'auto_review', 'guardian_subagent'].includes(input.approvalsReviewer)) {
    out.approvalsReviewer = input.approvalsReviewer;
  }
  if (input.permission !== undefined) {
    const mode = input.permission?.mode;
    const preset = Object.hasOwn(PERMISSION_PRESETS, mode || '') ? PERMISSION_PRESETS[mode] : null;
    if (!preset && mode !== 'host' && mode !== 'custom') throw new Error('Invalid permission mode');
    delete out.approvalPolicy;
    delete out.approvalsReviewer;
    delete out.sandbox;
    out.permission = { mode };
    if (preset) Object.assign(out, preset);
    if (mode === 'custom') {
      const custom = input.permission.custom;
      if (!custom || custom.permission !== undefined) throw new Error('Invalid custom permission');
      const clean = sanitizeTurnOverrides(custom);
      if (!clean.approvalPolicy || !clean.sandbox || !clean.approvalsReviewer) {
        throw new Error('Incomplete custom permission');
      }
      const values = { approvalPolicy: clean.approvalPolicy, approvalsReviewer: clean.approvalsReviewer, sandbox: clean.sandbox };
      Object.assign(out, values);
      out.permission.custom = values;
    }
  }
  if (typeof input.serviceTier === 'string' && input.serviceTier.trim()) {
    out.serviceTier = input.serviceTier.trim();
  }
  const collaborationMode = normalizeCollaborationMode(input.collaborationMode);
  if (collaborationMode) out.collaborationMode = collaborationMode;
  return out;
}

export function sandboxPolicyFromMode(mode) {
  const sandbox = normalizeSandbox(mode);
  if (sandbox === 'read-only') return { type: 'readOnly', networkAccess: false };
  if (sandbox === 'workspace-write') {
    return {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  return null;
}

export const SETTINGS_STORAGE_KEY = 'codex_cli_settings';

function readStorage(storage, key) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function loadCliSettings(storage) {
  const raw = readStorage(storage, SETTINGS_STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const clean = sanitizeTurnOverrides(parsed);
      if (Object.keys(clean).length) return clean;
    } catch {
      // fall through to legacy keys
    }
  }
  const legacySpeed = readStorage(storage, 'codex_selected_speed');
  return sanitizeTurnOverrides({
    model: readStorage(storage, 'codex_selected_model'),
    effort: readStorage(storage, 'codex_selected_reasoning'),
    approvalPolicy: readStorage(storage, 'codex_selected_approval'),
    sandbox: readStorage(storage, 'codex_selected_sandbox'),
    serviceTier: legacySpeed === '快速' ? 'fast' : legacySpeed === '标准' ? 'standard' : legacySpeed,
  });
}

export function saveCliSettings(storage, settings) {
  if (!storage || typeof storage.setItem !== 'function') return;
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ version: 2, ...sanitizeTurnOverrides(settings) }));
}

// 把「存下来的选择」补齐成「当前真正生效的设置」：用户没选过的项回落到服务端 status
// 与模型列表里的权威值。显示层（胶囊、列表选中态）和发送层（turn override）都必须走这里，
// 否则会重演那个缺陷——界面显示 GPT-5.5，turn/start 却不带 model，app-server 用自己的默认
// 模型并回 400；审批/沙箱列表则一项选中都没有。
// status 缺席（还没连上）时不编造值：留空，让服务端沿用自己的默认。
export function effectiveComposerSettings(stored = {}, { status = null, models = [] } = {}) {
  const source = stored && typeof stored === 'object' ? stored : {};
  const model = resolveSelectedModel(source.model || '', models);
  // 拿到模型档案才知道它支持哪些思考强度与服务档位；拿不到就不补，留空让服务端用自己的
  // 默认——和 approvalPolicy / sandbox 的处理保持一致，绝不编造界面上的选中态。
  const record = visibleModels(models).find(item => modelId(item) === model) || null;
  return {
    ...source,
    model,
    approvalPolicy: granularApprovalPolicy(source.approvalPolicy?.granular)
      || normalizeApprovalPolicy(source.approvalPolicy)
      || normalizeApprovalPolicy(status?.approvalPolicy)
      || '',
    sandbox: normalizeSandbox(source.sandbox)
      || normalizeSandbox(status?.sandbox)
      || '',
    effort: record ? clampEffortForModel(source.effort, record) : '',
    serviceTier: record ? clampServiceTierForModel(source.serviceTier, record) : '',
  };
}

export function buildTurnStartOverrides(settings = {}) {
  const clean = sanitizeTurnOverrides(settings);
  const out = {};
  if (clean.model) out.model = clean.model;
  if (clean.effort) out.effort = clean.effort;
  if (clean.approvalPolicy) out.approvalPolicy = clean.approvalPolicy;
  if (clean.approvalsReviewer) out.approvalsReviewer = clean.approvalsReviewer;
  if (clean.serviceTier) out.serviceTier = clean.serviceTier;
  const sandboxPolicy = sandboxPolicyFromMode(clean.sandbox);
  if (sandboxPolicy) out.sandboxPolicy = sandboxPolicy;
  // collaborationMode 刻意不进这里。它属于 ThreadSettings，只能经 thread/settings/update
  // 下发；TurnStartParams 的契约里没有这个字段，多带一个未知字段会让 app-server 整体
  // 反序列化失败，并回报一个指向别处的 `missing field \`model\``——即使 model 就在同一
  // 个 params 里。调用方仍可从 sanitizeTurnOverrides 的结果里读到它。
  return out;
}

// 协议的 Model.inputModalities 声明这个模型收什么。附件入口据此启用或禁用，免得用户
// 传完了才在 turn 里失败。
// 未声明时放行：inputModalities 在协议里是可选的，缺失不等于不支持，宁可让用户试一次，
// 也不该凭空禁掉一个可能可用的功能——「缺失信息不得猜测」在这里的方向是放行而非拦截。
export function modelAcceptsImages(model) {
  const modalities = model?.inputModalities;
  if (!Array.isArray(modalities) || modalities.length === 0) return true;
  return modalities.includes('image');
}
