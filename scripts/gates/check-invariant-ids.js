// scripts/gates/check-invariant-ids.js —— 不变量编号的双向闭合检查。
//
// 为什么需要它：`test/invariants/` 与 `test/unit/` 的执行槽完全相同（同一条 npm test、
// 同一份预加载），分的只是组织轴。**没有任何运行时后果的分类，靠人记是守不住的**——
// 放错目录不会红，写错编号不会红，删掉一条红线而留着登记也不会红。这个脚本把这三种
// 「不会红」变成会红。
//
// 四种失效形态，每一种都单独会红：
//   ① invariants/ 下的文件没写守护行            → 它凭什么在这个目录
//   ② 守护行引用了登记表里没有的编号            → 悬空引用，读者查不到红线正文
//   ③ 登记表里的编号在整棵 test/ 树里没人提      → 死条目，它会继续以「已经有测试了」的身份占位
//   ④ 扫描面塌陷（0 个文件或 0 行登记）          → 与「全部合规」在断言上不可区分
//
// ③ 的扫描面**故意放宽到整棵 test/ 树**，而不是只看 invariants/：有两条不变量（GATE-02、
// TEST-01）是由门禁守的，而按判据「测门禁的文件住 test/infra/」，它们不在 invariants/ 下。
// 收窄到 invariants/ 会把这两条误判成死条目，然后把人逼去删一条真红线。
//
// 用法：node scripts/gates/check-invariant-ids.js

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const REGISTRY = join(ROOT, 'test', 'README.md');
const INVARIANTS_DIR = join(ROOT, 'test', 'invariants');

// 编号形态两支：带连字符段的（DELIVER-01 / ENV-02 / R-SEC-1）与单字母加数字的（A2 / D6）。
// 上一版只写 /\b([A-Z]+-\d+)\b/，匹配不到 A2 与 D6，还会把 R-SEC-1 切成 SEC-1 —— 那种
// 半匹配比匹配不到更坏，它会在报错信息里给出一个看着像真的、其实不存在的编号。
export const INVARIANT_ID_RE = /\b([A-Z]+(?:-[A-Z0-9]+)*-\d+|[A-Z]\d+)\b/;

/** 从守护行里取编号。返回 null 表示这一行不是守护行。 */
export function guardIdOf(line) {
  // `(.*)` 不是 `(.+)`：`// 守护：` 后面空着仍然**是**一条守护行，只是没写编号。
  // 用 `(.+)` 会把它判成「不是守护行」，于是报错信息会说「第 2 行不是守护行」——
  // 而人明明写了那一行，照着提示去加只会加出第二条。两种失效要分开报。
  const marker = /^\s*\/\/\s*守护[：:]\s*(.*)$/.exec(line);
  if (!marker) return null;
  const id = INVARIANT_ID_RE.exec(marker[1]);
  return id ? id[1] : '';   // 空串 = 写了守护行但里面没有合法编号，与「没写」区分开
}

/**
 * 取登记表首列的编号。
 *
 * 只认首列是刻意的：红线正文里会出现别的编号（"与 zero-persistence-guard 的分工"
 * 那类交叉引用），把正文一起扫进来会让登记表自己制造出悬空条目。
 */
export function registryIds(markdown) {
  const ids = [];
  for (const line of String(markdown).split('\n')) {
    if (!line.startsWith('|')) continue;
    const first = line.split('|')[1];
    if (!first) continue;
    const id = INVARIANT_ID_RE.exec(first);
    if (id) ids.push(id[1]);
  }
  return ids;
}

/** 递归收集 test/ 下所有 .mjs 的内容，供 ③ 的反向检查用。 */
function readTestTree(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return readTestTree(full);
    return entry.name.endsWith('.mjs') ? [readFileSync(full, 'utf8')] : [];
  });
}

export function analyze({ registry, guards, corpus }) {
  const problems = [];
  const known = new Set(registry);

  if (registry.length === 0) problems.push('登记表一行都没解析出来——扫描面塌陷，这道闸已经失明');
  if (guards.length === 0) problems.push('test/invariants/ 下一个文件都没扫到——扫描面塌陷，这道闸已经失明');

  for (const { file, id } of guards) {
    if (id === null) {
      problems.push(`${file}：第 2 行不是守护行。invariants/ 下的文件必须声明它守哪条不变量，`
        + '否则它凭什么住在这个目录——按判据它应该在 unit/');
    } else if (id === '') {
      problems.push(`${file}：写了守护行但没有合法编号。形态是 \`// 守护：DELIVER-01\` 或 \`// 守护：A2\``);
    } else if (!known.has(id)) {
      problems.push(`${file} 守护的 ${id} 在 test/README.md 的登记表里查不到。`
        + '要么编号写错了，要么这条红线还没登记——读者顺着编号找不到红线正文时，守护行等于没写');
    }
  }

  for (const id of known) {
    if (!corpus.some(text => text.includes(id))) {
      problems.push(`登记表里的 ${id} 在整棵 test/ 树里一次都没被提到。`
        + '没人再守的红线会继续以「已经有测试了」的身份占着位置——删掉这条登记，或者把守它的测试补回来');
    }
  }

  return { ok: problems.length === 0, problems };
}

export function collectGuards(dir = INVARIANTS_DIR) {
  return readdirSync(dir)
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => ({
      file: `test/invariants/${name}`,
      id: guardIdOf(readFileSync(join(dir, name), 'utf8').split('\n')[1] ?? ''),
    }));
}

if (process.argv[1] && process.argv[1].endsWith('check-invariant-ids.js')) {
  const { ok, problems } = analyze({
    registry: registryIds(readFileSync(REGISTRY, 'utf8')),
    guards: collectGuards(),
    corpus: readTestTree(join(ROOT, 'test')),
  });
  if (!ok) {
    console.error('❌ 不变量编号检查未通过：\n');
    for (const problem of problems) console.error(`  · ${problem}\n`);
    process.exit(1);
  }
  console.log('✅ 不变量编号双向闭合');
}
