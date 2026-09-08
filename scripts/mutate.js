// scripts/mutate.js —— 变异测试：改坏一行源码，看断言会不会开口。
//
// 为什么需要它：唯一可靠的假绿判据是变异，不是阅读。本仓已知的假绿（`public-ui.test.mjs`
// 的 683 条源码文本断言、`app-server-transport` 那 4 个每次都被 cancelled 却显示 fail 0
// 的用例）全都躲得过人眼审查。存活的变异 = 那条断言没咬住行为。
//
// ⚠ 安全性：本脚本**改写源文件**，而改坏的可能恰恰是算路径或算删除目标的代码。
// 姊妹项目就是这么删掉过一整棵 ~/.claude/projects：变异把 getProjectDir 改成恒返回 ''，
// join(真实根, '') 塌成真实根本身，测试的 rmSync 打上去了。真正挡住它的是一次性 HOME，
// 不是下面那段恢复逻辑——容器被 kill 或变异中断时恢复逻辑根本不会执行。
// 所以：**没有 CCM_IN_CONTAINER 就拒绝运行**，无例外。
//
// 用法（宿主机上走 npm run mutate:docker，它会把这些参数透传进容器）：
//   node scripts/mutate.js <生产文件> [选项]
//     --tests=a.test.mjs,b.test.mjs   指定测试；不给则自动找 import 了该文件的
//     --lines=A-B                     只变异这个行号区间
//     --limit=N                       最多跑 N 个变异（控制耗时）
//     --timeout=MS                    单个变异的测试超时，默认 120000
//     --fail-on-survivors             有存活就以非 0 退出（CI 用）

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- 参数 ----

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (const arg of argv) {
  if (arg.startsWith('--')) {
    const [key, value] = arg.slice(2).split('=');
    flags.set(key, value === undefined ? true : value);
  } else {
    positional.push(arg);
  }
}

if (flags.has('help') || positional.length === 0) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(flags.has('help') ? 0 : 1);
}

// ---- 容器闸 ----
//
// 这道闸是白名单不是黑名单：不在容器里默认拒绝。判断错了顶多多跑一次容器，
// 判反了是删掉宿主机上的真实数据。

if (!process.env.CCM_IN_CONTAINER) {
  console.error('\n拒绝运行：变异会改写源码，改坏的可能正是算路径或算删除目标的代码。');
  console.error('在宿主机真实 HOME 上跑变异是姊妹项目那次删树事故的直接成因。\n');
  console.error('改用：  npm run mutate:docker -- ' + argv.join(' ') + '\n');
  process.exit(2);
}

const targetRel = positional[0];
const targetAbs = join(ROOT, targetRel);
if (!existsSync(targetAbs)) {
  console.error(`找不到 ${targetRel}`);
  process.exit(1);
}

const timeout = Number(flags.get('timeout') || 120000);
const limit = flags.get('limit') ? Number(flags.get('limit')) : Infinity;
let lineFrom = 1;
let lineTo = Infinity;
if (flags.get('lines')) {
  const [a, b] = String(flags.get('lines')).split('-').map(Number);
  lineFrom = a || 1;
  lineTo = b || a || Infinity;
}

// ---- 找测试文件 ----

function findTests() {
  if (flags.get('tests')) {
    return String(flags.get('tests')).split(',').map(t => t.includes('/') ? t : join('test', t));
  }
  // 自动匹配：找 import 了该生产文件的测试。同名优先，找不到再全扫。
  const stem = basename(targetRel).replace(/\.m?js$/, '');
  const all = readdirSync(join(ROOT, 'test')).filter(f => f.endsWith('.test.mjs'));
  const sameName = all.filter(f => f === `${stem}.test.mjs` || f.startsWith(`${stem}-`));
  const mentions = all.filter(f => {
    const src = readFileSync(join(ROOT, 'test', f), 'utf8');
    return new RegExp(`from\\s+['"][^'"]*${stem}\\.m?js['"]`).test(src);
  });
  const picked = [...new Set([...sameName, ...mentions])];
  return picked.map(f => join('test', f));
}

const testFiles = findTests();
if (testFiles.length === 0) {
  console.error(`没找到测试 ${targetRel} 的文件。用 --tests= 显式指定。`);
  process.exit(1);
}

// ---- 变异算子 ----
//
// 只放**能对应到具体假绿形态**的算子，不追求学术上的完备：
//   比较符 / 布尔      → 抓「断言过宽被相邻分支满足」
//   条件取反           → 抓「条件分支从未进入」
//   return null        → 抓算路径的函数（那次删树事故的形态）
//   逻辑运算符         → 抓多条件守卫里被忽略的那一半

const OPERATORS = [
  { name: '===→!==', find: /===/g, replace: '!==' },
  { name: '!==→===', find: /!==/g, replace: '===' },
  { name: '>=→>', find: />=/g, replace: '> ' },
  { name: '<=→<', find: /<=/g, replace: '< ' },
  { name: '&&→||', find: /&&/g, replace: '||' },
  { name: '||→&&', find: /\|\|/g, replace: '&&' },
  { name: 'true→false', find: /\btrue\b/g, replace: 'false' },
  { name: 'false→true', find: /\bfalse\b/g, replace: 'true ' },
];

// 把字符串、模板和行内注释的**内容**换成等长占位符，让正则只匹配到真代码。
// 长度保持一致，所以在 mask 上拿到的 index 可以直接用在原行上。
function mask(line) {
  let out = '';
  let quote = null;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') { out += '__'; i += 2; continue; }
      if (ch === quote) { quote = null; out += ch; i += 1; continue; }
      out += '_'; i += 1; continue;
    }
    if (ch === '/' && line[i + 1] === '/') { out += '_'.repeat(line.length - i); break; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    out += ch; i += 1;
  }
  return out;
}

const original = readFileSync(targetAbs, 'utf8');
const lines = original.split('\n');

function generate() {
  const out = [];
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (lineNo < lineFrom || lineNo > lineTo) return;
    const trimmed = line.trim();
    // 注释行里出现这些符号是在解释代码，不是代码。
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

    const masked = mask(line);

    for (const op of OPERATORS) {
      op.find.lastIndex = 0;
      let m;
      while ((m = op.find.exec(masked)) !== null) {
        const at = m.index;
        const mutated = line.slice(0, at) + op.replace + line.slice(at + m[0].length);
        out.push({ lineNo, op: op.name, before: trimmed, after: mutated.trim(), line: mutated });
      }
    }

    // 条件取反：if (X) → if (!(X))。需要配对右括号，正则做不到。
    const ifAt = masked.indexOf('if (');
    if (ifAt !== -1) {
      let depth = 0;
      let close = -1;
      for (let i = ifAt + 3; i < masked.length; i += 1) {
        if (masked[i] === '(') depth += 1;
        else if (masked[i] === ')') { depth -= 1; if (depth === 0) { close = i; break; } }
      }
      if (close !== -1) {
        const cond = line.slice(ifAt + 4, close);
        const mutated = `${line.slice(0, ifAt)}if (!(${cond}))${line.slice(close + 1)}`;
        out.push({ lineNo, op: 'if→!if', before: trimmed, after: mutated.trim(), line: mutated });
      }
    }

    // return X → return null。抓的是「把路径算错也没人管」那一类。
    const retMatch = /^(\s*)return\s+(?!null\b|undefined\b)(.+);\s*$/.exec(line);
    if (retMatch && mask(line).includes('return')) {
      const mutated = `${retMatch[1]}return null;`;
      out.push({ lineNo, op: 'return→null', before: trimmed, after: mutated.trim(), line: mutated });
    }
  });
  return out;
}

// ---- 跑 ----

let restored = false;
function restore() {
  if (restored) return;
  writeFileSync(targetAbs, original);
  restored = true;
}
// 恢复逻辑是礼貌，不是保障。保障是容器（见文件头）。
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { restore(); process.exit(sig === 'SIGINT' ? 130 : 143); });
}

function runTests() {
  return spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], {
    cwd: ROOT,
    timeout,
    encoding: 'utf8',
    env: { ...process.env, CODEX_DATA_DIR: process.env.CODEX_DATA_DIR || '/tmp/ccm-mutate-data' },
  });
}

console.log(`\n变异目标  ${targetRel}`);
console.log(`测试      ${testFiles.map(t => relative('test', t) === '' ? t : basename(t)).join(', ')}`);

// 基线：未变异时测试必须绿。跳过这步，本来就红的测试会让每个变异都算「被抓住」，
// 产出一份完全反过来的安全感。
process.stdout.write('基线      ');
const baseline = runTests();
if (baseline.status !== 0) {
  console.log('❌ 未变异时测试就是红的');
  console.log('\n变异结果没有意义，先修基线。测试输出：\n');
  console.log((baseline.stdout || '') + (baseline.stderr || ''));
  process.exit(1);
}
console.log('✅ 绿');

const candidates = generate();
console.log(`候选      ${candidates.length} 个变异`);

const results = { killed: 0, survived: [], invalid: 0 };
let ran = 0;

for (const mut of candidates) {
  if (ran >= limit) break;

  const mutatedSource = lines.map((l, i) => (i + 1 === mut.lineNo ? mut.line : l)).join('\n');
  writeFileSync(targetAbs, mutatedSource);

  // 语法错的变异不是有效变异，丢弃。这道检查让上面那些粗糙的正则变得可以接受。
  const syntax = spawnSync(process.execPath, ['--check', targetAbs], { encoding: 'utf8' });
  if (syntax.status !== 0) { results.invalid += 1; continue; }

  ran += 1;
  const run = runTests();
  if (run.status === 0) {
    results.survived.push(mut);
    console.log(`  ❗ 存活  ${basename(targetRel)}:${mut.lineNo}  [${mut.op}]  ${mut.after.slice(0, 70)}`);
  } else {
    results.killed += 1;
  }
}

restore();

// ---- 报告 ----

console.log(`\n跑了 ${ran} 个（跳过 ${results.invalid} 个语法错），杀掉 ${results.killed}，存活 ${results.survived.length}。`);

if (results.survived.length > 0) {
  console.log('\n存活的变异 = 那条断言没咬住行为。补的是断言，不是新层。');
  console.log('对照四种假绿形态（draft/TEST_PLAN.md §6）：');
  console.log('  · 测试与实现互相印证——手写 stub 而没 import 真的');
  console.log('  · 断言过宽被相邻分支满足——问「哪个错误实现也能让它绿」');
  console.log('  · 条件分支从未进入——每个分支要有只有它能满足的断言');
  console.log('  · 形态漏过整族——绊线只认一种写法');
}

process.exit(results.survived.length > 0 && flags.has('fail-on-survivors') ? 1 : 0);
