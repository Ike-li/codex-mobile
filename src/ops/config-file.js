// src/ops/config-file.js —— 配置的**文件源选择**与**值优先级合并**。
//
// 两件事分成两个函数，因为它们回答的是不同的问题，且各自都有踩过的坑：
//   ① loadConfigSources —— 读 codex.config.json 还是 .env
//   ② resolveConfigValues —— 同一个 key 两边都有时，谁赢
//
// 【为什么坏 JSON 直接抛】回落成空配置的后果不是「少几个设置」，是 server 以「未设
// AUTH_TOKEN」启动，然后按 server-security.js 的判据静默降级绑 127.0.0.1 —— 手机
// 全连不上，而日志里一个错字都没有。改坏一个逗号的代价不该是「服务看起来好好的
// 但没人能连」。fail-loud 在这里是唯一正确的方向。
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import dotenv from 'dotenv';
import { CODEX_SCHEMA, PASSTHROUGH_KEYS, coerceValue } from './codex-schema.js';

export const CONFIG_FILE_NAME = 'codex.config.json';
export const CONFIG_SCHEMA_VERSION = 1;

/**
 * 决定读哪一份配置文件。
 *
 * @returns {{source: 'config'|'env'|'none', fileValues: object, path: string|null, warnings: string[]}}
 */
export function loadConfigSources({ dir, configName = CONFIG_FILE_NAME, envName = '.env' } = {}) {
  const warnings = [];
  const configPath = join(dir, configName);
  const envPath = join(dir, envName);

  if (existsSync(configPath)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error(`${configName} 不是合法 JSON：${err.message}。`
        + '配置读不动时不回落空配置——那会让 server 以「未设 AUTH_TOKEN」启动并静默降级绑 127.0.0.1。');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${configName} 的顶层必须是对象（当前是 ${Array.isArray(parsed) ? '数组' : typeof parsed}）`);
    }
    if (existsSync(envPath)) {
      warnings.push(`${configName} 与 ${envName} 并存：以 ${configName} 为准，${envName} 已被忽略。`
        + '确认无误后可以删掉它——留着只会让下次改配置改错文件。');
    }
    return { source: 'config', fileValues: parsed, path: configPath, warnings };
  }

  if (existsSync(envPath)) {
    // 告警的前提是「照着做能解决问题」：这条命令现在真的存在了（scripts/config.js），
    // 且迁移不会删原文件，跑错了还有东西可对照。
    warnings.push(`仍在使用 ${envName}。跑 \`npm run config migrate\` 迁到 ${configName}——`
      + `WORKDIRS 会变成真数组，数值和开关也不再是字符串；原 ${envName} 不会被删。`);
    return { source: 'env', fileValues: dotenv.parse(readFileSync(envPath, 'utf8')), path: envPath, warnings };
  }

  // 两个都没有是全新安装的正常态，零告警。
  return { source: 'none', fileValues: {}, path: null, warnings };
}

/**
 * 合并优先级：**shell 环境变量 > 配置文件 > 各消费点自己的默认值**。
 *
 * 判据是 key 的**存在性**，不是值的非空性——`Object.hasOwn` 而不是真值判断。
 * 这一条逐字复刻 dotenv 的「不覆盖已存在 key」语义，包括那个反直觉的后果：
 * `export PORT=` 之后，shell 里的空串会**挡住**配置文件里的 PORT。
 *
 * 【为什么保留这个反直觉行为】让空串等同未设置、从而放行文件值，确实更合理
 * （`export X=` 在 shell 里就是「取消设置」的惯用写法）。但那是一次行为改变，
 * 而本阶段换加载器的全部价值在于「新旧投影逐键相等」这个可证明的性质——
 * 顺手改好一处语义就把这个证明弄没了，而这恰恰是重构最需要它的时候。
 * 改进留到消费点迁移那一批，届时它会有自己的一条测试，而不是躲在重构 diff 里。
 *
 * 空值的处理在下游：projectToEnv 对空串返回 null（不投影），加载器再统一删空串。
 */
export function resolveConfigValues({ fileValues = {}, shellEnv = {} } = {}) {
  const values = {};
  for (const [key, raw] of Object.entries(fileValues)) {
    if (raw == null) continue;
    values[key] = raw;
  }
  for (const [key, raw] of Object.entries(shellEnv)) {
    if (raw == null) continue;
    values[key] = raw;   // 存在即覆盖，含空串
  }
  return values;
}

/**
 * 把结构化值投影成 process.env 消费点认得的字符串。
 *
 * 返回 null 表示「不投影」。投影这一层在 JSON 配置下仍然必要：消费点全部是
 * `process.env.X` 的读法（B3 才迁），而 app-server-transport 的 childEnv() 直接
 * 展开 process.env 传给 codex 子进程 —— 不投影等于子进程什么都收不到。
 */
export function projectToEnv(key, value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Array.isArray(value) || (typeof value === 'object')) return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// .env → codex.config.json 的一次性迁移
// ---------------------------------------------------------------------------

/** 读 WORK_DIRS 指向的 JSON 文件；读不出来返回 null（调用方据此决定保留原键还是内联）。 */
function readWorkdirsFile(raw, baseDir) {
  const path = isAbsolute(raw) ? raw : join(baseDir, raw);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return null;
    return { path, entries: parsed.map(e => (typeof e === 'string' ? e : e?.path)).filter(Boolean) };
  } catch { return null; }
}

/**
 * 把一份 .env 的解析结果转成 codex.config.json 的结构化内容。
 *
 * 【工作区的折叠顺序不可换】先把 WORK_DIRS 展开成数组，再把 WORK_DIR 折进首项。
 * 反过来的话，WORK_DIR 会折进一个还没展开的字符串上，结果只剩它自己——
 * 而迁移仍然会报「成功」。
 *
 * 【读不出来的东西一律保留原键并告警，不静默丢弃】少搬一个工作区、换掉手机端默认
 * 打开的目录，用户都要等到下次开手机才发现，而那时已经没有 .env 可以对照了。
 */
export function migrateEnvValues(envValues = {}, { baseDir = process.cwd() } = {}) {
  const config = { $schemaVersion: CONFIG_SCHEMA_VERSION };
  const warnings = [];
  const rest = { ...envValues };

  // ① WORK_DIRS → 数组
  let workdirs = [];
  const rawWorkDirs = rest.WORK_DIRS;
  if (rawWorkDirs) {
    const fromFile = readWorkdirsFile(rawWorkDirs, baseDir);
    if (fromFile) {
      workdirs = fromFile.entries;
      warnings.push(`${rawWorkDirs} 的内容已内联进 WORKDIRS，该文件不再被读取，确认无误后可以删掉。`);
      delete rest.WORK_DIRS;
    } else if (rawWorkDirs.includes(',') || !rawWorkDirs.endsWith('.json')) {
      workdirs = coerceValue('WORKDIRS', rawWorkDirs);
      delete rest.WORK_DIRS;
    } else {
      warnings.push(`WORK_DIRS 指向的 ${rawWorkDirs} 读不出来（不存在、不是 JSON、或顶层不是数组），`
        + '已原样保留该键而不是丢弃——丢弃会让迁移后只剩一个工作区，而迁移仍然报成功。');
    }
  }

  // ② WORK_DIR 折进首项。它就是手机端默认打开的目录，丢掉等于悄悄换了个目录。
  const primary = rest.WORK_DIR;
  if (primary) {
    workdirs = [primary, ...workdirs.filter(p => p !== primary)];
    delete rest.WORK_DIR;
  }
  if (workdirs.length > 0) config.WORKDIRS = workdirs;

  // ③ 其余键按 schema 归一成 JSON 原生类型
  for (const [key, raw] of Object.entries(rest)) {
    if (raw === '' || raw == null) continue;
    if (Object.hasOwn(CODEX_SCHEMA, key)) {
      config[key] = coerceValue(key, raw);
    } else {
      config[key] = raw;
      if (!PASSTHROUGH_KEYS.includes(key)) {
        warnings.push(`${key} 不在配置表里，已原样保留——它不会被校验，也不会出现在配置面板上。`);
      }
    }
  }

  return { config, warnings };
}
