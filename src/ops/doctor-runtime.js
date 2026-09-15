// src/ops/doctor-runtime.js —— 自检的**探测层**与编排。
//
// 有副作用的东西全在这里：spawn 进程问版本、stat 磁盘、试着绑端口。
// 判定逻辑一行都不放（那在 doctor-checks.js），这样判定层才能在宿主机上零成本跑几百次。
//
// 每个探测器都接受注入：测试注入假实现，就不必真的去 spawn codex 或占端口——
// 姊妹项目实测过，不注入的话单文件耗时从 1.5s 涨到 56.8s，而多出来的 55s 全是等超时。
import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';
import {
  authTokenDiagnostic, bindDiagnostic, codexBinDiagnostic, computeReadiness,
  configFormatDiagnostic, configPermsDiagnostic, dataDirDiagnostic, envOverrideDiagnostic,
  headlessDiagnostic, logSwitchDiagnostic, portDiagnostic, versionPinDiagnostic,
  workdirsDiagnostic,
} from './doctor-checks.js';
import { ALL_CONFIG_KEYS } from './codex-schema.js';
import { resolveDataDir } from '../shared/data-dir.js';
import { checkPermissions } from '../../file-security.js';

/** 敏感文件清单。CLI 自检与将来的 web 体检共用同一份——分开写必然漂。 */
export const SENSITIVE_FILES = Object.freeze([
  'codex.config.json', '.env',
  'data/trusted-devices.json', 'data/pending-devices.json',
  'data/push-subscriptions.json', 'data/enrollment-token',
  'data/security-audit.jsonl', 'data/host-config-audit.jsonl',
]);

export function probeCodexBin({ explicit = '', exec = execFileSync } = {}) {
  let resolved = explicit;
  if (!resolved) {
    try { resolved = String(exec('which', ['codex'], { encoding: 'utf8' })).trim(); } catch { resolved = ''; }
  }
  if (!resolved) return { explicit, resolved: '', exists: false, version: '' };

  let exists = false;
  try { exists = statSync(resolved).isFile(); } catch { exists = false; }
  if (!exists) return { explicit, resolved, exists: false, version: '' };

  try {
    return { explicit, resolved, exists, version: String(exec(resolved, ['--version'], { encoding: 'utf8' })).trim() };
  } catch (err) {
    return { explicit, resolved, exists, version: '', versionError: String(err?.message || err) };
  }
}

export function probeWorkdirs(paths = []) {
  return paths.map(path => {
    let isDirectory = false;
    let writable = false;
    try {
      isDirectory = statSync(path).isDirectory();
      accessSync(path, constants.W_OK);
      writable = true;
    } catch { /* 记成不可用即可，具体原因对用户没有额外价值 */ }
    return { path, isDirectory, writable };
  });
}

export function probeDataDir(dir = resolveDataDir()) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    accessSync(dir, constants.W_OK);
    return { path: dir, writable: true };
  } catch { return { path: dir, writable: false }; }
}

/**
 * 敏感文件权限。返回 null 表示「这个平台查不了」——绝不假报 0。
 * 报 0 是假绿：它让人以为查过了，而 Windows 的 ACL 根本不是 POSIX mode。
 */
export function probeConfigPerms({ root, platform = process.platform } = {}) {
  if (platform === 'win32') return { problemCount: null, checked: 0 };
  const paths = SENSITIVE_FILES.map(name => join(root, name)).filter(existsSync);
  return { problemCount: checkPermissions(paths).length, checked: paths.length };
}

/**
 * 端口占用：直接试着绑一下。
 *
 * 比解析 lsof / /proc 好的地方是它跨平台且判据直接——我们要知道的正是「server 能不能
 * 绑上去」，而不是「有没有某个进程看起来占着它」。
 */
export function probePort(port, { host = '127.0.0.1', createServer = net.createServer } = {}) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', err => resolve({ free: false, code: err?.code || 'EADDRINUSE' }));
    server.once('listening', () => server.close(() => resolve({ free: true })));
    try { server.listen(port, host); } catch { resolve({ free: false, code: 'EADDRINUSE' }); }
  });
}

/** 哪些配置键被 shell 环境变量压过了。只出键名。 */
export function probeEnvOverrides({ shellEnv = {}, keys = ALL_CONFIG_KEYS } = {}) {
  return keys.filter(key => typeof shellEnv[key] === 'string' && shellEnv[key] !== '');
}

/**
 * 编排。ctx 全部由调用方喂，本函数不自己去读配置——doctor 与 server 必须看到同一份，
 * 而「各读各的」正是 doctor 报绿但 server 起不来的经典成因。
 */
export function runDoctor(ctx = {}) {
  const {
    source = 'none', configPath = null, configError = null,
    token = '', host = '127.0.0.1', port = 3001,
    codexProbe = {}, pinnedVersion = '',
    workdirProbes = [], dataDirProbe = {}, permsProbe = {},
    portProbe = { free: true }, schemaProbe = null,
    display = '', wayland = '',
    logStderr = false, rpcLog = true, rpcLogBytes = 0, rpcLogCap = 0,
    envOverrides = [],
  } = ctx;

  const checks = [
    configFormatDiagnostic({ source, path: configPath, error: configError }),
    authTokenDiagnostic({ token, host }),
    bindDiagnostic({ host, port, tokenLength: String(token || '').length }),
    codexBinDiagnostic(codexProbe),
    versionPinDiagnostic({ actual: codexProbe.version, pinned: pinnedVersion }),
    workdirsDiagnostic({ probes: workdirProbes }),
    dataDirDiagnostic(dataDirProbe),
    configPermsDiagnostic(permsProbe),
    portDiagnostic({ port, free: portProbe.free, selfLikely: portProbe.free === false }),
    headlessDiagnostic({ display, wayland }),
    logSwitchDiagnostic({ stderr: logStderr, rpcLog, rpcLogBytes, rpcLogCap }),
    envOverrideDiagnostic({ overridden: envOverrides }),
  ];

  // schema 探测要起真 app-server，不是每个调用场景都负担得起（单测就不该）。
  // 没探测就**不出这一项**，而不是出一个「ok」——后者是假绿。
  if (schemaProbe) checks.push(schemaProbe);

  return { checks, readiness: computeReadiness(checks) };
}
