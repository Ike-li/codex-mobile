// scripts/doctor.js —— 启动自检的 CLI 宿主。
//
// 三层里最薄的一层：参数、取数、打印、退出码。判定在 src/ops/doctor-checks.js，
// 探测在 src/ops/doctor-runtime.js。
//
// 【配置必须走 loadRuntimeConfig，不能自己读一份】doctor 的全部价值在于
// 「它看到的 = server 启动时会看到的」。各读各的话，最典型的故障——配置文件放错位置、
// 被环境变量压过、格式不对——恰恰是 doctor 看不见的那一类。
//
// 【schema 探测要起真 app-server】所以它不在 `npm test` 里跑（会打真 ~/.codex），
// 只在这条命令里跑，而这条命令被宿主机钩子管辖。--skip-probe 可以跳过。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { loadRuntimeConfig } from '../src/ops/config.js';
import { schemaVerdict, schemaProbeDiagnostic } from '../src/ops/doctor-checks.js';
import {
  probeCodexBin, probeConfigPerms, probeDataDir, probeEnvOverrides,
  probePort, probeWorkdirs, runDoctor,
} from '../src/ops/doctor-runtime.js';
import { resolveDataDir } from '../src/shared/data-dir.js';
import { resolveWorkdirAllowlist, resolveWorkdirsFromEntries } from '../src/files/workdir-allowlist.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 重新导出，保持既有 import 路径可用（test/invariants/doctor.test.mjs 守着 ENV-02）。 */
export { schemaVerdict };

/**
 * 用一次只读调用探测状态库能不能读。
 *
 * 判据是「这条链路现在能不能用」，不是「库里有哪些表」——本项目不直接读 sqlite
 * （~/.codex 下有六个带版本后缀的库），状态库由 codex 进程独占，只能通过 app-server 观察。
 *
 * @param {{request: (method: string, params?: object) => Promise<unknown>}} deps
 *   request 是外部边界（codex 子进程），注入以便测试。
 */
export async function probeSchema({ request, pinnedVersion = '' }) {
  try {
    // 只读、零额度。发 turn 那类会真的调用模型，与「日常回归不消耗额度」冲突。
    await request('thread/list', { pageSize: 1 });
    return { compatible: true };
  } catch (err) {
    const raw = String(err?.message || err);
    const verdict = schemaVerdict(raw, { pinnedVersion });
    if (!verdict.compatible) return verdict;
    return { compatible: true, probeError: raw };
  }
}

/**
 * 按 server 的那两条入口解析实际生效的工作区。
 *
 * 判据与 server.js#initializeWorkDirs 逐字相同。解析不出来时返回空数组而不是抛——
 * 「一个工作区都没有」本身就是 workdirsDiagnostic 要报的那条 fail，自检不该
 * 因为被检对象有问题而自己崩掉。
 */
function resolveEffectiveWorkdirs(cfg) {
  try {
    const resolved = cfg.WORKDIRS?.length > 0
      ? resolveWorkdirsFromEntries({ entries: cfg.WORKDIRS })
      : resolveWorkdirAllowlist({
        workDir: process.env.WORK_DIR || '',
        extra: process.env.WORK_DIRS || '',
        baseDir: ROOT,
      });
    return resolved.workDirs;
  } catch { return []; }
}

function readPin() {
  try { return readFileSync(join(ROOT, '.codex-version'), 'utf8').trim(); } catch { return ''; }
}

/** 收集全部事实。schemaProbe 由调用方决定要不要跑——它要起真进程。 */
export async function collectDoctorContext({ schemaProbe = null } = {}) {
  // **必须在 loadRuntimeConfig 之前取**：加载器会把配置文件里的值投影进 process.env，
  // 投影之后再看就分不清「这个键来自 shell」还是「来自配置文件」——第一版就是这么
  // 把 AUTH_TOKEN 和 VAPID 全报成「被环境变量压过」的。
  const shellEnv = { ...process.env };
  let load;
  let configError = null;
  try {
    load = loadRuntimeConfig();
  } catch (err) {
    configError = String(err?.message || err);
    load = { values: {}, source: 'none', path: null, warnings: [] };
  }
  const cfg = load.values;

  const codexProbe = probeCodexBin({ explicit: cfg.CODEX_BIN || '' });
  const portProbe = await probePort(cfg.PORT ?? 3001, { host: cfg.HOST || '127.0.0.1' });

  return {
    source: load.source, configPath: load.path, configError,
    token: cfg.AUTH_TOKEN || '', host: cfg.HOST || '127.0.0.1', port: cfg.PORT ?? 3001,
    codexProbe, pinnedVersion: readPin(),
    // 工作区必须按 server 的那两条入口解析，不能只看 CFG.WORKDIRS：.env 部署里工作区
    // 藏在 `WORK_DIRS=workdirs.json` 后面，只看新键会报出「1 个工作区」而实际有 6 个。
    // 报少了比报错更坏——它看起来是个正常结果。
    workdirProbes: probeWorkdirs(resolveEffectiveWorkdirs(cfg)),
    dataDirProbe: probeDataDir(resolveDataDir()),
    permsProbe: probeConfigPerms({ root: ROOT }),
    portProbe,
    schemaProbe,
    display: process.env.DISPLAY || '', wayland: process.env.WAYLAND_DISPLAY || '',
    logStderr: !!cfg.LOG_STDERR, rpcLog: cfg.CODEX_RPC_LOG !== false,
    rpcLogCap: cfg.CODEX_RPC_LOG_MAX_BYTES ?? 0,
    envOverrides: probeEnvOverrides({ shellEnv }),
  };
}

const ICON = { ok: '✅', warn: '⚠️ ', fail: '❌' };

async function main() {
  const asJson = process.argv.includes('--json');
  const skipProbe = process.argv.includes('--skip-probe');

  let schemaProbe = null;
  if (!skipProbe) {
    // 起真 app-server 要拉起 codex 子进程。失败不该让整个自检跑不完——
    // 其余十二项与它无关，而「因为一项探测挂了就什么都看不到」是最差的自检体验。
    try {
      const { AppServerHost } = await import('../src/agent/app-server-host.js');
      const host = new AppServerHost();
      const result = await probeSchema({ request: (m, p) => host.request(m, p), pinnedVersion: readPin() });
      schemaProbe = schemaProbeDiagnostic(result);
      await host.dispose?.();
    } catch (err) {
      schemaProbe = schemaProbeDiagnostic({ compatible: true, probeError: String(err?.message || err) });
    }
  }

  const { checks, readiness } = runDoctor(await collectDoctorContext({ schemaProbe }));

  if (asJson) {
    console.log(JSON.stringify({ readiness, checks }, null, 2));
  } else {
    console.log('');
    for (const check of checks) console.log(`${ICON[check.status]} ${check.id.padEnd(20)} ${check.detail}`);
    console.log(`\n${readiness.level === 'ready' ? '✅' : readiness.level === 'caution' ? '⚠️ ' : '❌'} ${readiness.summary}\n`);
  }
  process.exit(readiness.level === 'blocked' ? 1 : 0);
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (invokedDirectly()) await main();
