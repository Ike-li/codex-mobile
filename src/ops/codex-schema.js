// src/ops/codex-schema.js —— 配置项的单一事实源：有哪些键、什么类型、默认值是多少。
//
// 【为什么要有这张表】换血前，同一个判据
//   `const raw = Number(process.env.X); const X = Number.isInteger(raw) && raw > 0 ? raw : 默认`
// 在 server.js 里逐字重复了 8 次，在 agent-appserver.js 里又有第二份实现（numberFromEnv），
// 而 CODEX_APPROVAL_POLICY / CODEX_SANDBOX 两个枚举**一次校验都没有**——写错拼写会原样
// 透传给 app-server，症状是行为不对而日志里什么都没有。默认值散在 8 个三元表达式里，
// 也就没有任何地方能回答「这个配置项的默认值是多少」。
//
// 【条目里不放校验函数】校验按 kind 分支集中在 checkOne()。条目只描述「是什么」，
// 不描述「怎么查」——把校验逻辑塞进条目会让每加一个配置项都要重新发明一次判据。
//
// 【文案只有中文】本仓没有 i18n 层。姊妹项目的 {zh,en} 是它自己的历史约束，照搬过来
// 只会得到一列永远等于 null 的英文。

export const DEFAULT_PORT = 3001;

// 下界一分钟。曾经接受 0 只是为了测试方便，但那意味着误配成 0 时，任何一个断开连接的
// 会话都会在下一个 5 分钟 tick 里被立刻回收。测试改用注入时钟，不再需要这个口子。
export const MIN_AGENT_IDLE_TTL_MS = 60_000;

const APPROVAL_POLICIES = ['untrusted', 'on-failure', 'on-request', 'never'];
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];

/**
 * kind 决定校验分支与投影形态：
 *   number  —— 必须是整数且落在 [min, max]；越界回落 default
 *   toggle  —— JSON 里是 boolean；投影成 '1' / '0'
 *   enum    —— 必须在 values 里；不在就是硬错误（不静默回落，见下）
 *   list    —— JSON 数组
 *   secret  —— 同 text，但永不回显
 *   text / path / url —— 字符串
 *   readonly —— 不接受写入（改它要重启，且极易把自己锁在门外）
 */
export const CODEX_SCHEMA = Object.freeze({
  // ---- auth ----
  AUTH_TOKEN: {
    group: 'auth', kind: 'readonly', secret: true, default: '',
    label: '访问令牌',
    help: '留空时 server 只接受本机访问（非 loopback 一律 403）。要更换请跑 setup——'
      + '换掉之后所有已注册设备都要重新批准。',
  },
  HOST: {
    group: 'auth', kind: 'text', default: '127.0.0.1',
    label: '监听地址',
    help: '非 loopback 地址要求 AUTH_TOKEN 至少 32 字符，否则拒绝启动。判据在 server-security.js。',
  },
  PORT: {
    // min 是 0 不是 1：0 = 让系统分配随机端口，是一个被使用中的语义。
    // 照搬「端口必须 >= 1」会静默掐掉它，而症状是「配了 0 却起在 3001」。
    group: 'auth', kind: 'number', min: 0, max: 65535, default: DEFAULT_PORT,
    label: '监听端口', help: '0 表示由系统分配随机端口。',
  },
  CODEX_ALLOWED_ORIGINS: {
    group: 'auth', kind: 'list', default: [],
    label: '允许的来源（Origin）',
    help: '跨源访问白名单。归一与校验复用 server-security.js，不在此处另写一份 URL 解析。',
  },
  CODEX_TRUSTED_PROXY_IPS: {
    group: 'auth', kind: 'list', default: [],
    label: '可信反向代理 IP', help: '只接受 IP 字面量，不支持 CIDR 与主机名。',
  },
  CODEX_ALLOW_INSECURE_REMOTE: {
    group: 'auth', kind: 'toggle', default: false,
    label: '允许不加密的远程访问', help: '仅用于局域网自测。公网暴露前必须关掉。',
  },
  CODEX_SESSION_TTL_MS: {
    group: 'auth', kind: 'number', min: 60_000, default: 7 * 24 * 60 * 60 * 1000,
    label: '登录会话有效期', unit: 'ms',
  },
  CODEX_AUTH_MAX_FAILURES: {
    group: 'auth', kind: 'number', min: 1, default: 5,
    label: '鉴权失败锁定阈值', help: '同一来源在窗口内失败这么多次后进入锁定。',
  },
  CODEX_AUTH_WINDOW_MS: {
    group: 'auth', kind: 'number', min: 1000, default: 60_000,
    label: '鉴权失败统计窗口', unit: 'ms',
  },
  CODEX_PENDING_DEVICE_LIMIT: {
    group: 'auth', kind: 'number', min: 1, default: 32,
    label: '待批准设备上限', help: '防止未授权来源把待批列表刷爆。',
  },

  // ---- runtime ----
  WORKDIRS: {
    group: 'runtime', kind: 'list', reload: 'hot', default: [],
    label: '工作区列表',
    help: '每项是绝对路径。**第一项就是手机端默认打开的目录**。',
  },
  CODEX_BIN: {
    group: 'runtime', kind: 'path', executable: true, default: '',
    label: 'codex 可执行文件', help: '留空则从 PATH 查找。',
  },
  CODEX_APPROVAL_POLICY: {
    group: 'runtime', kind: 'enum', values: APPROVAL_POLICIES, default: 'on-request',
    label: '审批策略',
    help: '写错拼写此前会原样透传给 app-server——行为不对而日志里什么都没有。现在启动期就拒绝。',
  },
  CODEX_SANDBOX: {
    group: 'runtime', kind: 'enum', values: SANDBOX_MODES, default: 'workspace-write',
    label: '沙箱模式', help: '同上，此前无校验。danger-full-access 会解除文件系统限制。',
  },
  CODEX_P3_EXPERIMENTAL: {
    group: 'runtime', kind: 'toggle', default: false,
    label: '实验性 app-server 能力',
    help: '变量名是历史遗留（Labs 面板已删）。现在它唯一的用途是让 thread/settings/update 可用。',
  },
  CODEX_ALLOW_REMOTE_IMAGES: {
    group: 'runtime', kind: 'toggle', default: false,
    label: '允许引用远程图片 URL', help: '开启后输入里的 https 图片链接会被下发。有 SSRF 面，默认关。',
  },

  // ---- limits ----
  IDLE_TIMEOUT_MS: {
    group: 'limits', kind: 'number', min: 1, default: 600_000,
    label: '会话空闲超时', unit: 'ms',
  },
  CODEX_AGENT_IDLE_TTL_MS: {
    group: 'limits', kind: 'number', min: MIN_AGENT_IDLE_TTL_MS, default: 30 * 60 * 1000,
    label: 'agent 闲置回收时限', unit: 'ms',
  },
  CODEX_EVENT_BUFFER_CAP: {
    group: 'limits', kind: 'number', min: 1, default: 500,
    label: '事件重放缓冲条数',
  },
  CODEX_INPUT_QUEUE_LIMIT: {
    group: 'limits', kind: 'number', min: 1, default: 20,
    label: '输入排队上限',
  },
  CODEX_INTERRUPT_TIMEOUT_MS: {
    group: 'limits', kind: 'number', min: 1, default: 2000,
    label: '中断等待时限', unit: 'ms',
  },
  CODEX_PUSH_MAX_SUBSCRIPTIONS: {
    group: 'limits', kind: 'number', min: 1, default: 64,
    label: '推送订阅上限',
  },
  CODEX_SECURITY_AUDIT_MAX_BYTES: {
    group: 'limits', kind: 'number', min: 65_536, default: 1024 * 1024,
    label: '安全审计单文件上限', unit: 'bytes',
  },
  CODEX_RPC_LOG_MAX_BYTES: {
    group: 'limits', kind: 'number', min: 65_536, default: 8 * 1024 * 1024,
    label: 'RPC 日志单文件上限', unit: 'bytes',
  },
  CODEX_BACKPRESSURE_RETRIES: {
    group: 'limits', kind: 'number', min: 1, default: 5,
    label: '背压重试次数', help: '向 app-server 写入遇到背压时的重试上限。',
  },
  CODEX_BACKPRESSURE_BASE_MS: {
    group: 'limits', kind: 'number', min: 1, default: 250,
    label: '背压重试基准间隔', unit: 'ms',
  },

  // ---- push ----
  VAPID_PUBLIC_KEY: {
    group: 'push', kind: 'secret', default: '', together: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
    label: 'VAPID 公钥',
  },
  VAPID_PRIVATE_KEY: {
    group: 'push', kind: 'secret', default: '', together: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
    label: 'VAPID 私钥',
  },
  VAPID_SUBJECT: {
    group: 'push', kind: 'text', default: '', together: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
    label: 'VAPID subject', help: 'mailto: 或 https: 开头。',
  },

  // ---- logs ----
  LOG_STDERR: {
    group: 'logs', kind: 'toggle', default: false,
    label: '打印调试日志到 stderr',
  },
  CODEX_RPC_LOG: {
    // 注意方向：消费点的判据是 `=== '0'` 关。所以 false 必须投成 '0'，不能投成空串。
    group: 'logs', kind: 'toggle', default: true,
    label: '记录 RPC 帧日志', help: '落在工作区根的 .codex-chat-rpc.jsonl，按字节轮转一代。',
  },
});

/**
 * 真实被消费、但不该出现在配置面板里的键。
 *
 * 显式名单而不是「非大写开头就放行」：后者会让任何拼错的键名静默变成 passthrough，
 * 而拼错的配置项与没配置在行为上完全一样。
 */
export const PASSTHROUGH_KEYS = Object.freeze([
  'CODEX_DATA_DIR',        // 状态根。改它是一次迁移，不是一个设置
  'CODEX_SERVER_NO_START', // 测试/嵌入钩子
  'WORK_DIR',              // 已折进 WORKDIRS 首项，保留是因为 shell 里可能还 export 着
  'WORK_DIRS',             // 同上
]);

export const ALL_CONFIG_KEYS = Object.freeze([...Object.keys(CODEX_SCHEMA), ...PASSTHROUGH_KEYS]);

export const schemaDef = key => (Object.hasOwn(CODEX_SCHEMA, key) ? CODEX_SCHEMA[key] : null);
export const isSecret = def => !!def?.secret || def?.kind === 'secret';

// ---------------------------------------------------------------------------
// 归一：字符串/JSON 值 → 类型化值
// ---------------------------------------------------------------------------
const TRUTHY = new Set(['1', 'true', 'on', 'yes']);

/**
 * 把一个原始值按 schema 归一。**越界或不合法一律回落 default**，不抛——
 * 抛不抛是调用方按场景决定的（启动期拒绝 vs 面板里标红），这里只负责得出一个能用的值。
 * 想知道「它合法吗」用 checkOne。
 */
export function coerceValue(key, raw) {
  const def = schemaDef(key);
  if (!def) return raw;
  if (raw === undefined || raw === null || raw === '') return def.default;

  switch (def.kind) {
    case 'number': {
      const n = Number(raw);
      const min = def.min ?? Number.NEGATIVE_INFINITY;
      const max = def.max ?? Number.POSITIVE_INFINITY;
      return Number.isInteger(n) && n >= min && n <= max ? n : def.default;
    }
    case 'toggle':
      if (typeof raw === 'boolean') return raw;
      return TRUTHY.has(String(raw).toLowerCase());
    case 'enum':
      return def.values.includes(raw) ? raw : def.default;
    case 'list': {
      if (Array.isArray(raw)) return raw;
      const text = String(raw).trim();
      if (text.startsWith('[')) {
        try {
          const parsed = JSON.parse(text);
          return Array.isArray(parsed) ? parsed : def.default;
        } catch { return def.default; }
      }
      // 逗号分隔是 .env 时代的形态，迁移期仍要认。
      return text ? text.split(',').map(s => s.trim()).filter(Boolean) : def.default;
    }
    default:
      return String(raw);
  }
}

/** 单键校验。返回 null 表示合法，否则是一句人话的问题描述。 */
export function checkOne(key, raw) {
  const def = schemaDef(key);
  if (!def) return null;
  if (raw === undefined || raw === null || raw === '') return null; // 未设置 = 用默认值，合法

  switch (def.kind) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isInteger(n)) return `${key} 必须是整数，当前是 ${JSON.stringify(raw)}`;
      if (def.min !== undefined && n < def.min) return `${key} 不能小于 ${def.min}，当前是 ${n}`;
      if (def.max !== undefined && n > def.max) return `${key} 不能大于 ${def.max}，当前是 ${n}`;
      return null;
    }
    case 'enum':
      return def.values.includes(raw)
        ? null
        : `${key} 只能是 ${def.values.join(' / ')} 之一，当前是 ${JSON.stringify(raw)}`;
    case 'list': {
      if (Array.isArray(raw) || typeof raw === 'string') return null;
      return `${key} 必须是数组，当前是 ${typeof raw}`;
    }
    default:
      return null;
  }
}

/**
 * 整份校验。**失败方向按 kind 分档，不是「所有不合法都拒绝」**：
 *
 *   enum 非法   → error，启动期拒绝。回落是危险的：用户以为自己配了 danger-full-access
 *                 或 never，实际跑的是另一套语义，而两者都不会有任何提示。拼错一个字母
 *                 就换了一套安全边界，这件事必须当场停下来。
 *   number 越界 → warning，回落默认值。这是本仓**已经选过并测过**的方向
 *                 （server-integration 有一条用例就叫「an out-of-range idle TTL falls back
 *                 to the default instead of reclaiming everything」）。而且拒绝启动意味着
 *                 一次升级就能让一台配了越界值、原本跑得好好的部署起不来——代价不对称。
 *   成套缺项    → warning。推送不会工作，但服务本身是好的。
 */
export function validateConfig(values = {}) {
  const errors = [];
  const warnings = [];

  for (const [key, raw] of Object.entries(values)) {
    if (!Object.hasOwn(CODEX_SCHEMA, key)) continue;  // passthrough 与未登记键不校验
    const problem = checkOne(key, raw);
    if (!problem) continue;
    if (CODEX_SCHEMA[key].kind === 'enum') errors.push(problem);
    else warnings.push(`${problem}——已回落默认值 ${JSON.stringify(CODEX_SCHEMA[key].default)}`);
  }

  // 成套约束：配一半比一个都不配更危险——它看起来像是配好了。
  const groups = new Set();
  for (const def of Object.values(CODEX_SCHEMA)) if (def.together) groups.add(def.together.join(','));
  for (const group of groups) {
    const keys = group.split(',');
    const present = keys.filter(k => values[k] !== undefined && values[k] !== null && values[k] !== '');
    if (present.length > 0 && present.length < keys.length) {
      warnings.push(`${keys.join(' / ')} 要么都配、要么都不配，当前只配了 ${present.join(' / ')}——`
        + '推送不会工作，但没有任何地方会报错。');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
