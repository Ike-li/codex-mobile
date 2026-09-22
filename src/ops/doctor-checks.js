// src/ops/doctor-checks.js —— 自检的**判定层**：纯函数，零 IO。
//
// 【为什么判定与探测分开】探测要 spawn 进程、要 stat 磁盘、要试着绑端口，在宿主机上跑
// 一次就是秒级；而「拿到这些事实之后该说什么」是纯逻辑，本该毫秒级跑完并被大量覆盖。
// 混在一起的后果是判定逻辑只能靠端到端验证，于是实际上没人测它——而自检本身出错的症状
// 恰恰是「它说没问题」。
//
// 【每个函数的签名都是单个 options 对象 + 全默认值】调用方少传一个字段时得到的是
// 「这项查不了」而不是崩溃，自检不该因为自己缺一个输入就整个跑不完。
//
// 【safe 字段只出布尔 / 计数 / 枚举字面量】它会被贴进 issue 和截图。绝不出明文令牌、
// 绝对路径、URL 值——那些正是人贴 doctor 输出时最容易连带泄露的东西。
import { SCHEMA_MISMATCH } from '../../public/js/session/thread-actions.js';

/** 统一形状。status 三档：ok / warn（能跑但要知道）/ fail（这条不解决就别期待它能用）。 */
const verdict = (id, status, detail, safe) => ({ id, status, detail, ...(safe ? { safe } : {}) });

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export function configFormatDiagnostic({ source = 'none', path = null, error = null } = {}) {
  if (error) return verdict('CONFIG_FORMAT', 'fail', `配置文件读不动：${error}`, { source });
  if (source === 'config') return verdict('CONFIG_FORMAT', 'ok', `使用 codex.config.json`, { source });
  if (source === 'env') {
    return verdict('CONFIG_FORMAT', 'warn',
      '仍在使用 .env。跑 `npm run config migrate` 迁到 codex.config.json——'
      + 'WORKDIRS 会变成真数组，数值和开关不再是字符串，原 .env 不会被删。', { source });
  }
  return verdict('CONFIG_FORMAT', 'fail',
    '没有找到任何配置文件。跑 `npm run config init` 生成一份（含随机 AUTH_TOKEN）。', { source, path: !!path });
}

/**
 * 令牌强度。判据随绑定面变化：只听本机时空令牌是可用状态（非 loopback 一律 403 兜底），
 * 对外监听时它是唯一的门。
 */
export function authTokenDiagnostic({ token = '', host = '127.0.0.1' } = {}) {
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  const length = String(token || '').length;
  const safe = { set: length > 0, length, loopback };

  if (length === 0) {
    return loopback
      ? verdict('AUTH_TOKEN', 'warn', '未设置访问令牌。现在只有本机能连（非 loopback 一律 403）；'
        + '要从手机连就必须先设，跑 `npm run config init`。', safe)
      : verdict('AUTH_TOKEN', 'fail', `监听在 ${host} 却没有访问令牌——任何人都能连。`, safe);
  }
  if (!loopback && length < 32) {
    return verdict('AUTH_TOKEN', 'fail',
      `对外监听要求令牌至少 32 字符，当前 ${length}。生成：openssl rand -hex 32`, safe);
  }
  if (length < 32) {
    return verdict('AUTH_TOKEN', 'warn', `令牌只有 ${length} 字符。改成对外监听前要换成至少 32 字符的。`, safe);
  }
  return verdict('AUTH_TOKEN', 'ok', `访问令牌已设置（${length} 字符）`, safe);
}

/** 监听面。这一项答的是「谁能连到它」，不是「配得对不对」。 */
export function bindDiagnostic({ host = '127.0.0.1', port = 3001, tokenLength = 0 } = {}) {
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  const safe = { loopback, wildcard: host === '0.0.0.0' || host === '::' };

  if (loopback) return verdict('BIND', 'ok', `只监听本机 ${host}:${port}，手机要连需经反代或隧道`, safe);
  if (tokenLength < 32) {
    return verdict('BIND', 'fail', `监听 ${host} 但令牌不足 32 字符，server 会拒绝启动。`, safe);
  }
  return verdict('BIND', 'warn',
    `监听 ${host}:${port}，局域网内任何设备都能触达。确认这台机器不在不可信网络里。`, safe);
}

// ---------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------

export function codexBinDiagnostic({ explicit = '', resolved = '', exists = false, version = '', versionError = null } = {}) {
  const safe = { explicit: !!explicit, found: !!resolved, exists, hasVersion: !!version };
  if (!resolved) {
    return verdict('CODEX_BIN', 'fail', explicit
      ? `CODEX_BIN 指向的 ${explicit} 找不到。`
      : '在 PATH 上找不到 codex。装了 Codex CLI 之后重试，或在配置里设 CODEX_BIN。', safe);
  }
  if (!exists) return verdict('CODEX_BIN', 'fail', `codex 路径解析到 ${resolved}，但那个文件不存在。`, safe);
  if (!version) {
    return verdict('CODEX_BIN', 'warn',
      `找到 codex 但问不出版本${versionError ? `（${versionError}）` : ''}。它可能不可执行。`, safe);
  }
  return verdict('CODEX_BIN', 'ok', `codex ${version}`, safe);
}

/**
 * 本机 codex 版本与 .codex-version 的对齐。
 *
 * 这一项是 warn 不是 fail：版本不齐时**协议门禁**会红（那才是硬闸），而自检的职责是
 * 让人知道「你现在看到的行为可能不是这个仓库预期的那一版」。把它做成 fail 会让任何
 * 只想检查配置的人被一个与配置无关的问题挡住。
 */
export function versionPinDiagnostic({ actual = '', pinned = '' } = {}) {
  const safe = { pinned: !!pinned, matches: false };
  if (!pinned) return verdict('CODEX_VERSION_PIN', 'warn', '仓库里没有 .codex-version，无法核对版本。', safe);
  if (!actual) return verdict('CODEX_VERSION_PIN', 'warn', `问不出本机 codex 版本，无法核对是否为 ${pinned}。`, safe);

  const normalized = actual.replace(/^codex-cli\s+/i, '').trim();
  if (normalized === pinned || normalized.endsWith(` ${pinned}`) || normalized.includes(pinned)) {
    return verdict('CODEX_VERSION_PIN', 'ok', `codex 与 .codex-version 对齐（${pinned}）`, { ...safe, matches: true });
  }
  return verdict('CODEX_VERSION_PIN', 'warn',
    `本机 codex 是 ${normalized}，而仓库 pin 的是 ${pinned}。协议门禁会因此变红；`
    + `对齐：npm i -g @openai/codex@${pinned}`, safe);
}

/** 状态库 schema 判定。~/.codex 全局共享，桌面版一升级就单向写入新迁移。 */
export function schemaVerdict(raw, { pinnedVersion = '' } = {}) {
  if (!raw || !SCHEMA_MISMATCH.test(raw)) return { compatible: true };
  return {
    compatible: false,
    hint: '状态库里缺表或缺列，多半是跑着的 codex 比 ~/.codex 里的库旧。\n'
      + '     ~/.codex 是全局共享的，桌面版 Codex 升级会单向写入新迁移。\n'
      + `     下一步：把 codex 对齐到 .codex-version（${pinnedVersion || '见该文件'}），`
      + '或确认 CODEX_HOME 指向的是同一个目录。',
  };
}

export function schemaProbeDiagnostic({ compatible = true, hint = '', probeError = null } = {}) {
  if (!compatible) return verdict('SCHEMA_PROBE', 'fail', hint, { compatible: false });
  if (probeError) {
    // 探测没成功但不是 schema 问题。静默当成通过等于这道检查不存在。
    return verdict('SCHEMA_PROBE', 'warn', `状态库探测没能完成：${probeError}`, { compatible: true, probed: false });
  }
  return verdict('SCHEMA_PROBE', 'ok', '状态库可读', { compatible: true, probed: true });
}

// ---------------------------------------------------------------------------
// 目录与权限
// ---------------------------------------------------------------------------

export function workdirsDiagnostic({ probes = [] } = {}) {
  const usable = probes.filter(p => p.isDirectory && p.writable);
  const safe = { total: probes.length, usable: usable.length };

  if (probes.length === 0) {
    return verdict('WORKDIRS', 'fail',
      '没有配置任何工作区。不配时**不会**回落到家目录——那等于把 ~/.ssh、~/.aws、'
      + '其他项目的 .env 一并交给 agent。', safe);
  }
  if (usable.length === 0) return verdict('WORKDIRS', 'fail', `配了 ${probes.length} 个工作区，一个都不可用。`, safe);

  const broken = probes.filter(p => !p.isDirectory || !p.writable);
  if (broken.length > 0) {
    return verdict('WORKDIRS', 'warn',
      `${usable.length}/${probes.length} 个工作区可用，这些不可用：${broken.map(p => p.path).join('、')}`, safe);
  }
  return verdict('WORKDIRS', 'ok', `${usable.length} 个工作区，主目录 ${probes[0].path}`, safe);
}

export function dataDirDiagnostic({ writable = false, path = '' } = {}) {
  return writable
    ? verdict('DATA_DIR', 'ok', `状态目录可写：${path}`, { writable: true })
    : verdict('DATA_DIR', 'fail',
      `状态目录不可写：${path}。设备表、推送订阅和审计都写在这里，不可写等于设备批不了。`,
      { writable: false });
}

/**
 * 敏感文件的权限。
 *
 * problemCount 为 **null** 表示「这个平台查不了」（Windows 的 ACL 不是 POSIX mode），
 * 那时报 warn 而不是 ok —— 报 ok 是假绿，它会让人以为查过了。
 */
export function configPermsDiagnostic({ problemCount = null, checked = 0 } = {}) {
  if (problemCount === null) {
    return verdict('CONFIG_PERMS', 'warn', '当前平台无法检查文件权限，这一项没有被验证。', { checked: false });
  }
  if (problemCount > 0) {
    return verdict('CONFIG_PERMS', 'fail',
      `${problemCount} 个敏感文件的权限过宽（应为 0600/0700）。它们含令牌与设备凭据。`,
      { checked: true, problems: problemCount });
  }
  return verdict('CONFIG_PERMS', 'ok', `${checked} 个敏感文件权限正常`, { checked: true, problems: 0 });
}

export function portDiagnostic({ port = 3001, free = true, selfLikely = false } = {}) {
  if (free) return verdict('PORT', 'ok', `端口 ${port} 空闲`, { free: true });
  return selfLikely
    ? verdict('PORT', 'warn', `端口 ${port} 已被占用——多半就是已经在跑的这个 server。`, { free: false })
    : verdict('PORT', 'fail', `端口 ${port} 被占用，server 起不来。换个端口或停掉占用方。`, { free: false });
}

// ---------------------------------------------------------------------------
// 运行环境
// ---------------------------------------------------------------------------

/**
 * 无图形界面也能跑。
 *
 * 这一项恒 ok，存在的理由是**它是本产品相对官方远控唯一一条结构上的优势**：官方要求
 * host 跑 ChatGPT 桌面 app（仅 macOS/Windows）并保持不休眠，而服务器不会休眠。
 * 把它写成一条自检项，是为了让这条承诺有个可复核的落点。
 */
export function headlessDiagnostic({ display = '', wayland = '' } = {}) {
  const headless = !display && !wayland;
  return verdict('HEADLESS', 'ok',
    headless ? '无图形界面环境——本服务不需要桌面 app，这正是它能跑在服务器上的原因'
      : '有图形界面，但本服务不依赖它',
    { headless });
}

export function logSwitchDiagnostic({ stderr = false, rpcLog = true, rpcLogBytes = 0, rpcLogCap = 0 } = {}) {
  const safe = { stderr, rpcLog, nearCap: rpcLogCap > 0 && rpcLogBytes > rpcLogCap * 0.8 };
  const notes = [];
  if (stderr) notes.push('LOG_STDERR 开着：调试日志会持续写 stderr');
  if (safe.nearCap) notes.push(`RPC 日志已到上限的 ${Math.round((rpcLogBytes / rpcLogCap) * 100)}%，即将轮转`);
  return notes.length > 0
    ? verdict('LOG_SWITCHES', 'warn', notes.join('；'), safe)
    : verdict('LOG_SWITCHES', 'ok', '日志开关正常', safe);
}

/**
 * 哪些配置键被 shell 环境变量压过了。
 *
 * **只报键名，绝不回显值**——被压住的那个键很可能正是 AUTH_TOKEN 或 VAPID 私钥，
 * 而 doctor 的输出是人最常贴进 issue 的东西。
 */
export function envOverrideDiagnostic({ overridden = [] } = {}) {
  if (overridden.length === 0) return verdict('ENV_OVERRIDE', 'ok', '没有配置项被环境变量覆盖', { count: 0 });
  return verdict('ENV_OVERRIDE', 'warn',
    `这些配置项被 shell 环境变量压过了，配置文件里的值不生效：${overridden.join('、')}`,
    { count: overridden.length });
}

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

export function computeReadiness(checks = []) {
  const failed = checks.filter(c => c.status === 'fail');
  const warned = checks.filter(c => c.status === 'warn');
  if (failed.length > 0) {
    return { level: 'blocked', summary: `${failed.length} 项必须先解决：${failed.map(c => c.id).join('、')}` };
  }
  if (warned.length > 0) {
    return { level: 'caution', summary: `${warned.length} 项值得看一眼：${warned.map(c => c.id).join('、')}` };
  }
  return { level: 'ready', summary: `${checks.length} 项全部通过` };
}
