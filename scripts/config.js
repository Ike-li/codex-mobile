// scripts/config.js —— headless 配置 CLI：init | get | set | unset | check | migrate | schema
//
// 这是唯一会**写**配置文件的地方，所以每条写入路径都有一道「写错了会怎样」的防线：
//   · 全或无      —— 一批赋值里只要有一个不合法，一个都不写。部分写入最糟：一半生效
//                    一半没有，而命令报的是失败，人会以为什么都没变。
//   · 只读键      —— AUTH_TOKEN 不接受 set/unset。改它到重启之间文件与进程不一致，
//                    重启后含正在操作的这台手机在内全部要重输，极易把自己锁在门外。
//   · 迁移窗口闸  —— 只有 .env 而没有 codex.config.json 时拒绝写入（见 guardWriteTarget）。
//   · 未知 flag   —— 不静默忽略。`--revael` 被当成没写的话，人会以为屏幕上那串就是明文。
//
// 用法：node scripts/config.js <命令> [参数...]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { writeOwnerOnlyFile } from '../file-security.js';
import {
  CONFIG_FILE_NAME, CONFIG_SCHEMA_VERSION, migrateEnvValues,
} from '../src/ops/config-file.js';
import {
  CODEX_SCHEMA, PASSTHROUGH_KEYS, schemaDef, isSecret, validateConfig,
} from '../src/ops/codex-schema.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const KNOWN_FLAGS = new Set(['--json', '--reveal', '--force']);

const configPathOf = dir => join(dir, CONFIG_FILE_NAME);
const readConfigFile = dir => (existsSync(configPathOf(dir))
  ? JSON.parse(readFileSync(configPathOf(dir), 'utf8'))
  : {});
const writeConfigFile = (dir, config) =>
  writeOwnerOnlyFile(configPathOf(dir), `${JSON.stringify(config, null, 2)}\n`);

export function parseConfigArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const unknownFlags = [];
  const assignments = [];
  const positionals = [];

  for (const arg of rest) {
    if (arg.startsWith('--')) {
      if (KNOWN_FLAGS.has(arg)) flags[arg.slice(2)] = true;
      else unknownFlags.push(arg);
    } else if (arg.includes('=')) {
      // 只按**首个** = 切分：VAPID 私钥、ntfy token 这类值自带等号。
      const at = arg.indexOf('=');
      assignments.push([arg.slice(0, at), arg.slice(at + 1)]);
    } else {
      positionals.push(arg);
    }
  }
  return { command, flags, unknownFlags, assignments, positionals };
}

const CLI_TRUE = new Set(['true', 'on', 'yes', '1']);
const CLI_FALSE = new Set(['false', 'off', 'no', '0']);

/**
 * 终端输入 → 类型化值。**刻意不复用 schema 的 coerceValue**。
 *
 * 那一份喂的是 .env 字面量，判据是「在不在真值表里」，于是任何不认识的词都静默变成
 * false。对 .env 那是对的（历史形态千奇百怪），但在终端里 `set LOG_STDERR=yse` 静默
 * 关掉日志是错的——人打错了字，应该当场知道，而不是过两天发现日志没了。
 */
export function parseCliValue(key, raw) {
  const def = schemaDef(key);
  if (!def) return raw;

  switch (def.kind) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new Error(`${key} 需要一个整数，收到 ${JSON.stringify(raw)}`);
      return n;
    }
    case 'toggle': {
      const text = String(raw).toLowerCase();
      if (CLI_TRUE.has(text)) return true;
      if (CLI_FALSE.has(text)) return false;
      throw new Error(`${key} 需要 true/false（或 on/off、yes/no、1/0），收到 ${JSON.stringify(raw)}`);
    }
    case 'list': {
      const text = String(raw).trim();
      if (!text.startsWith('[')) {
        throw new Error(`${key} 需要一个 JSON 数组，例如 '["/a","/b"]'。`
          + '不猜逗号串——含逗号的路径会被拆坏，而拆坏之后看起来仍像是配好了。');
      }
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error(`${key} 的 JSON 顶层必须是数组`);
      return parsed;
    }
    default:
      return String(raw);
  }
}

/**
 * 迁移窗口期的写入闸。
 *
 * 不拦的话，`config set PORT=4100` 会在只有 .env 的部署上生成一份**只含 PORT** 的
 * codex.config.json，而它的优先级高于 .env —— 整份 .env 被一个看起来无害的命令悄悄
 * 遮蔽，症状是「改了一个端口，结果令牌和工作区全没了」。
 */
function guardWriteTarget(dir) {
  if (existsSync(configPathOf(dir))) return null;
  if (!existsSync(join(dir, '.env'))) return null;
  return `检测到 .env 但还没有 ${CONFIG_FILE_NAME}。先跑 \`node scripts/config.js migrate\`——`
    + `直接写入会生成一份只含本次改动的 ${CONFIG_FILE_NAME}，而它的优先级高于 .env，`
    + '结果是整份旧配置被静默遮蔽。';
}

function formatValue(key, value, { reveal = false } = {}) {
  if (isSecret(schemaDef(key)) && !reveal) {
    const length = String(value ?? '').length;
    return length > 0 ? `<已设置，${length} 字符>` : '';
  }
  return value;
}

// ---------------------------------------------------------------------------

function cmdInit(dir, flags) {
  if (existsSync(configPathOf(dir)) && !flags.force) {
    return { ok: false, problems: [`${CONFIG_FILE_NAME} 已存在。--force 会生成一个新的 AUTH_TOKEN，`
      + '所有已注册设备都要重新批准——确定要这样再加。'] };
  }
  const config = { $schemaVersion: CONFIG_SCHEMA_VERSION, AUTH_TOKEN: randomBytes(32).toString('hex') };
  writeConfigFile(dir, config);
  return { ok: true, data: { path: configPathOf(dir) } };
}

function cmdGet(dir, { positionals, flags }) {
  const config = readConfigFile(dir);
  const keys = positionals.length > 0 ? positionals : Object.keys(config).filter(k => k !== '$schemaVersion');
  const problems = [];
  const entries = {};

  for (const key of keys) {
    // 显式点名一个不存在的键要报错：打印 `NOPE=` 然后退 0 会让人以为
    // 「这个键存在只是没设」，而它根本就是拼错的。
    if (positionals.length > 0 && !Object.hasOwn(CODEX_SCHEMA, key) && !PASSTHROUGH_KEYS.includes(key)) {
      problems.push(`${key} 不是已登记的配置项。跑 \`config schema\` 看全部可用的键。`);
      continue;
    }
    entries[key] = formatValue(key, config[key], flags);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, data: entries };
}

function applyChanges(dir, changes) {
  const blocked = guardWriteTarget(dir);
  if (blocked) return { ok: false, problems: [blocked] };

  const readonly = Object.keys(changes).filter(k => schemaDef(k)?.kind === 'readonly');
  if (readonly.length > 0) {
    return { ok: false, problems: [`${readonly.join(' / ')} 是只读项，不能用 set/unset 改。`
      + '改它到重启之间文件与进程不一致，重启后所有设备（含你正在用的这台）都要重新输入令牌。'] };
  }

  const next = { ...readConfigFile(dir) };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }

  // 全或无：一个不合法就整批不写。
  const { ok, errors } = validateConfig(next);
  if (!ok) return { ok: false, problems: errors };

  next.$schemaVersion = CONFIG_SCHEMA_VERSION;
  writeConfigFile(dir, next);
  return { ok: true, data: { changed: Object.keys(changes) } };
}

function cmdSet(dir, { assignments }) {
  if (assignments.length === 0) return { ok: false, problems: ['用法：config set KEY=VALUE [KEY=VALUE...]'] };
  const changes = {};
  for (const [key, raw] of assignments) {
    try { changes[key] = parseCliValue(key, raw); } catch (err) { return { ok: false, problems: [err.message] }; }
  }
  return applyChanges(dir, changes);
}

function cmdUnset(dir, { positionals }) {
  if (positionals.length === 0) return { ok: false, problems: ['用法：config unset KEY [KEY...]'] };
  return applyChanges(dir, Object.fromEntries(positionals.map(key => [key, null])));
}

function cmdCheck(dir) {
  const config = readConfigFile(dir);
  const { ok, errors, warnings } = validateConfig(config);
  return ok ? { ok: true, data: { warnings } } : { ok: false, problems: errors, data: { warnings } };
}

function cmdMigrate(dir) {
  if (existsSync(configPathOf(dir))) {
    return { ok: false, problems: [`${CONFIG_FILE_NAME} 已存在，迁移会覆盖它。先备份或删除再迁。`] };
  }
  const envPath = join(dir, '.env');
  if (!existsSync(envPath)) return { ok: false, problems: ['没有找到 .env，没什么可迁的。'] };

  const { config, warnings } = migrateEnvValues(dotenv.parse(readFileSync(envPath, 'utf8')), { baseDir: dir });
  writeConfigFile(dir, config);
  // 刻意不删 .env：迁移错了还得有东西可对照，而删掉是不可逆的。
  return { ok: true, data: { path: configPathOf(dir), warnings, keptEnv: envPath } };
}

function cmdSchema() {
  const items = Object.entries(CODEX_SCHEMA).map(([key, def]) => ({
    key, group: def.group, kind: def.kind, label: def.label,
    default: def.default, values: def.values, help: def.help,
  }));
  return { ok: true, data: { items, passthrough: PASSTHROUGH_KEYS } };
}

export function runConfigCommand(argv, { dir = ROOT } = {}) {
  const parsed = parseConfigArgs(argv);
  if (parsed.unknownFlags.length > 0) {
    return { ok: false, problems: [`不认识的参数：${parsed.unknownFlags.join(' ')}。`
      + '不静默忽略是有意的——把 --revael 当成没写的话，你会以为屏幕上那串就是明文。'] };
  }
  try {
    switch (parsed.command) {
      case 'init': return cmdInit(dir, parsed.flags);
      case 'get': return cmdGet(dir, parsed);
      case 'set': return cmdSet(dir, parsed);
      case 'unset': return cmdUnset(dir, parsed);
      case 'check': return cmdCheck(dir);
      case 'migrate': return cmdMigrate(dir);
      case 'schema': return cmdSchema();
      default:
        return { ok: false, problems: ['用法：config init|get|set|unset|check|migrate|schema'] };
    }
  } catch (err) {
    return { ok: false, problems: [err.message] };
  }
}

// realpath 比对：macOS 上 /var 是 /private/var 的软链，直接比字符串会让 main 永不执行。
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (invokedDirectly()) {
  const result = runConfigCommand(process.argv.slice(2));
  const asJson = process.argv.includes('--json');

  if (asJson) {
    console.log(JSON.stringify({ ok: result.ok, ...(result.data ?? {}), problems: result.problems }, null, 2));
  } else if (result.ok) {
    for (const warning of result.data?.warnings ?? []) console.warn(`⚠️  ${warning}`);
    if (result.data && !Array.isArray(result.data)) {
      for (const [key, value] of Object.entries(result.data)) {
        if (key === 'warnings' || key === 'items') continue;
        console.log(`${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
      }
      for (const item of result.data.items ?? []) {
        console.log(`${item.key.padEnd(32)} ${item.kind.padEnd(9)} 默认 ${JSON.stringify(item.default)}  ${item.label}`);
      }
    }
  } else {
    for (const problem of result.problems ?? []) console.error(`❌ ${problem}`);
  }
  process.exit(result.ok ? 0 : 1);
}
