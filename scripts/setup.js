// scripts/setup.js —— 装机向导：从零到「手机能连上」。
//
// 【向导的危险不在装不上，在替用户做了他不知道的决定】
// 把家目录当工作区、在没有 TTY 的地方悄悄走完交互分支、覆盖掉一份还在用的配置——
// 这三件都不会报错，而后果要到很久以后才显形。所以这里的主体是一张**拒绝矩阵**，
// 每一条都宁可停下来问，也不替用户猜。
//
// 用法：
//   node scripts/setup.js                                  交互
//   node scripts/setup.js --yes --work-dir=/abs/path ...   非交互（CI / 脚本）
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeOwnerOnlyFile } from '../src/files/file-security.js';
import { CONFIG_FILE_NAME, CONFIG_SCHEMA_VERSION } from '../src/ops/config-file.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const HOST_CHOICES = ['127.0.0.1', '0.0.0.0'];

export function parseSetupArgs(argv = []) {
  const parsed = { workDirs: [], unknown: [] };
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') parsed.yes = true;
    else if (arg === '--force') parsed.force = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg.startsWith('--work-dir=')) {
      const value = arg.slice('--work-dir='.length);
      if (!parsed.workDirs.includes(value)) parsed.workDirs.push(value);
    } else if (arg.startsWith('--host=')) parsed.host = arg.slice('--host='.length);
    else parsed.unknown.push(arg);
  }
  return parsed;
}

/**
 * 工作区归一。
 *
 * 【家目录被拒】把家目录当工作区 = 把 ~/.ssh、~/.aws、其他项目的 .env 一并交给 agent。
 * 这与「不配工作区时拒绝启动」是同一条红线的两个入口——只堵一边等于没堵，
 * 因为向导正是最容易让人随手敲个 ~ 的地方。
 */
export function normalizeWorkDir(raw, { home = homedir() } = {}) {
  const expanded = raw?.startsWith('~/') ? join(home, raw.slice(2)) : raw;
  if (!expanded || !isAbsolute(expanded)) return { ok: false, code: 'work_dir_not_absolute' };
  const normalized = resolve(expanded);
  if (normalized === resolve(home)) return { ok: false, code: 'work_dir_is_home' };
  return { ok: true, workDir: normalized };
}

/**
 * 唯一的决策点。纯函数——所有 IO（TTY 探测、文件存在性）由调用方查好传进来。
 *
 * 拒绝的顺序不是随意的：unknown_flag 排在最前，因为它很可能**正是**用户以为自己
 * 指定了的那一项（`--work-dirs=` 多写一个 s）。先报别的会把注意力引开。
 */
export function resolveSetupPlan({
  args = {}, configExists = false, isTty = true, home = homedir(),
} = {}) {
  if (args.help) return { mode: 'help' };
  const mode = args.yes ? 'noninteractive' : 'interactive';
  const refuse = (code, detail) => ({ mode, refuse: { code, detail } });

  if (args.unknown?.length) return refuse('unknown_flag', args.unknown.join(' '));
  if (args.host !== undefined && !HOST_CHOICES.includes(args.host)) {
    // 不猜意图：「lan」大概率想要 0.0.0.0，但替用户猜着写进配置会一直生效到
    // 有人发现为止，而那时它已经把服务暴露在局域网上了。
    return refuse('invalid_host', `只接受 ${HOST_CHOICES.join(' 或 ')}，收到 ${args.host}`);
  }

  if (!args.yes) {
    // 在 CI 或管道里跑时，交互分支会读到 EOF 然后按「默认值」走完——
    // 而那些默认值从来没有人确认过。
    if (!isTty) return refuse('tty_required', '没有可交互的终端。非交互请加 --yes 并显式给出 --work-dir。');
    return { mode, workDirs: args.workDirs ?? [], host: args.host, force: args.force };
  }

  if (!args.workDirs?.length) {
    return refuse('work_dir_required', '--yes 模式必须显式给出 --work-dir。不给不会回落到家目录。');
  }
  const normalized = [];
  for (const raw of args.workDirs) {
    const result = normalizeWorkDir(raw, { home });
    if (!result.ok) return refuse(result.code, raw);
    normalized.push(result.workDir);
  }
  if (configExists && !args.force) {
    return refuse('config_exists',
      `${CONFIG_FILE_NAME} 已存在。想保留现有配置请跑 \`npm run config migrate\` 或直接改那个文件；`
      + '--force 会生成一个新的 AUTH_TOKEN，所有已注册设备都要重新批准。');
  }

  // 危险动作的缺省值必须落在保守那一侧：默认对外监听意味着「跑一遍装机命令」
  // 就把服务暴露到局域网。
  return { mode, workDirs: normalized, host: args.host ?? '127.0.0.1' };
}

export function buildSetupConfig({ workDirs, host, token = randomBytes(32).toString('hex') }) {
  return { $schemaVersion: CONFIG_SCHEMA_VERSION, AUTH_TOKEN: token, HOST: host, WORKDIRS: workDirs };
}

const REFUSE_HINT = {
  unknown_flag: '不认识的参数。不静默忽略是有意的——它很可能正是你以为已经指定了的那一项。',
  tty_required: '没有可交互的终端。',
  work_dir_required: '必须显式给出至少一个工作区。',
  work_dir_not_absolute: '工作区必须是绝对路径——相对路径会让权限边界取决于从哪个目录启动。',
  work_dir_is_home: '不能把家目录当工作区：那等于把 ~/.ssh、~/.aws、其他项目的 .env 一并交给 agent。',
  config_exists: '配置已存在。',
  invalid_host: '监听地址只接受 127.0.0.1（仅本机）或 0.0.0.0（局域网可达）。',
};

async function runInteractive(plan, { outPath, ask, log }) {
  log('\n⚙  Codex Chat Mobile —— 装机向导\n');

  if (existsSync(outPath) && !plan.force) {
    const answer = (await ask(`${CONFIG_FILE_NAME} 已存在，覆盖它？覆盖会生成新的 AUTH_TOKEN，所有已注册设备都要重新批准。[y/N] `)).trim().toLowerCase();
    if (answer !== 'y') {
      log('\n已取消。想改现有配置用 `npm run config set`，想从 .env 迁移用 `npm run config migrate`。\n');
      return null;
    }
  }

  // 工作区先问：下一问（监听地址）的措辞要建立在「你已经知道放行了哪些目录」之上。
  const workDirs = [];
  log('工作区是 agent 能读写的目录。第一个就是手机端默认打开的那个。');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const raw = (await ask(workDirs.length === 0 ? '  主工作区（绝对路径）：' : '  再加一个（回车结束）：')).trim();
    if (!raw) {
      if (workDirs.length > 0) break;
      log('  ⚠️  至少要有一个工作区——不设时服务会拒绝启动，不会回落到家目录。');
      continue;
    }
    const result = normalizeWorkDir(raw);
    if (!result.ok) { log(`  ❌ ${REFUSE_HINT[result.code]}`); continue; }
    if (!existsSync(result.workDir)) { log(`  ❌ 目录不存在：${result.workDir}`); continue; }
    if (!workDirs.includes(result.workDir)) workDirs.push(result.workDir);
  }

  log('\n手机怎么连过来？');
  log('  1) 仅本机（127.0.0.1）—— 手机要连需在前面架反代或隧道。默认。');
  log(`  2) 局域网直连（0.0.0.0）—— 同一 WiFi 下任何设备都能触达这 ${workDirs.length} 个工作区。`);
  const choice = (await ask('  选择 [1/2]：')).trim();
  const host = choice === '2' ? '0.0.0.0' : '127.0.0.1';

  return { workDirs, host };
}

function printRefusal(refuse, log) {
  log(`\n❌ ${REFUSE_HINT[refuse.code] ?? refuse.code}`);
  if (refuse.detail) log(`   ${refuse.detail}`);
  log('');
}

async function main() {
  const log = line => process.stdout.write(`${line}\n`);
  const args = parseSetupArgs(process.argv.slice(2));
  const outPath = join(ROOT, CONFIG_FILE_NAME);

  if (args.help) {
    log('\n用法：node scripts/setup.js [--yes --work-dir=<绝对路径> ... --host=127.0.0.1|0.0.0.0] [--force]\n');
    return 0;
  }

  const plan = resolveSetupPlan({
    args, configExists: existsSync(outPath), isTty: Boolean(process.stdin.isTTY), home: homedir(),
  });
  if (plan.refuse) { printRefusal(plan.refuse, log); return 2; }

  let answers = { workDirs: plan.workDirs, host: plan.host };
  if (plan.mode === 'interactive') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      answers = await runInteractive(plan, { outPath, ask: q => rl.question(q), log });
    } finally { rl.close(); }
    if (!answers) return 0;
  }

  const config = buildSetupConfig(answers);
  writeOwnerOnlyFile(outPath, `${JSON.stringify(config, null, 2)}\n`);

  // 令牌提示**必须排在写盘之后**。反过来的话，问答被 Ctrl-C 或 EOF 打断时
  // 一个字节都没写，而屏幕上已经报了成功。
  log(`\n✅ 已写入 ${CONFIG_FILE_NAME}（权限 0600）`);
  log(`   工作区：${config.WORKDIRS.length} 个，主目录 ${config.WORKDIRS[0]}`);
  log(`   监听：${config.HOST}`);
  log('\n下一步：');
  log('   npm start          启动服务');
  log('   npm run qr         把连接地址打成二维码，免手输令牌');
  log('   npm run doctor     启动自检\n');
  return 0;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) process.exit(await main());
