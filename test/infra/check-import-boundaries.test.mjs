// test/infra/check-import-boundaries.test.mjs —— 模块边界门禁自身的每条规则各红一次。
//
// 为什么要逐条测：这道闸守的是「结构别缠死」，而结构缠死是**渐进**的——没有任何一次
// 改动会让它当场变红。一条写错的规则因此可以静默地永远绿着，而它占着「边界有人管」
// 这个位置。所以每条规则都必须被证明能红一次，扫描面塌陷也要单独会红。
//
// 用真实的 analyze / parseImports，不手写 stub。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyze, parseImports, findCycles, buildFromDisk,
  BOUNDARY_RULES, SHARED_ALLOWLIST, FROZEN_ROOT_MODULES, FROZEN_PUBLIC_MODULES,
} from '../../scripts/gates/check-import-boundaries.js';

// 一份最小的合规仓库形状，各用例在它上面只改一处。
const base = {
  edges: [
    { from: 'server.js', to: 'devices.js' },
    { from: 'src/ops/metrics.js', to: 'src/shared/data-dir.js' },
    { from: 'public/js/app.js', to: 'public/js/logic/unread.js' },
  ],
  rootFiles: ['server.js', 'devices.js'],
  publicFiles: ['public/js/app.js'],
};

const namesOf = ({ problems }) => problems.map(p => p.rule);

test('合规形状不报任何违规', () => {
  const result = analyze(base);
  assert.equal(result.ok, true, JSON.stringify(result.problems, null, 2));
});

test('规则表非空，且每条都有名字与说明', () => {
  assert.ok(BOUNDARY_RULES.length >= 6, `只有 ${BOUNDARY_RULES.length} 条规则，疑似规则表被截断`);
  for (const rule of BOUNDARY_RULES) {
    assert.equal(typeof rule.name, 'string');
    assert.ok(rule.describe.length > 0, `${rule.name} 没有说明——违规时报错信息会说不清违反了什么`);
  }
});

test('frontend-no-backend：前端 import 后端 → 红', () => {
  const r = analyze({ ...base, edges: [{ from: 'public/js/app.js', to: 'src/ops/metrics.js' }] });
  assert.equal(r.ok, false);
  assert.ok(namesOf(r).includes('frontend-no-backend'));
});

test('frontend-no-backend：前端 import 根目录冻结模块也算 → 红', () => {
  const r = analyze({ ...base, edges: [{ from: 'public/js/app.js', to: 'devices.js' }] });
  assert.equal(r.ok, false);
  assert.ok(namesOf(r).includes('frontend-no-backend'));
});

test('backend-no-frontend：后端 import 前端 → 红', () => {
  const r = analyze({ ...base, edges: [{ from: 'src/ops/metrics.js', to: 'public/js/markdown.js' }] });
  assert.equal(r.ok, false);
  assert.ok(namesOf(r).includes('backend-no-frontend'));
});

test('backend-no-frontend：三个具名共享模块是豁免，不报', () => {
  // 这三条边是真实存在的：server.js 与 agent-appserver.js 消费 cli-settings 的归一化，
  // statusline.js 消费 token-usage 的字段归一。豁免收窄到具名文件，不开目录级后门。
  const r = analyze({
    ...base,
    edges: [
      { from: 'server.js', to: 'public/js/cli-settings.js' },
      { from: 'agent-appserver.js', to: 'public/js/cli-settings.js' },
      { from: 'statusline.js', to: 'public/js/token-usage.js' },
    ],
    rootFiles: ['server.js', 'agent-appserver.js', 'statusline.js'],
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems, null, 2));
});

test('shared-is-leaf：src/shared 反向 import 其他域 → 红', () => {
  const r = analyze({ ...base, edges: [{ from: 'src/shared/data-dir.js', to: 'src/ops/metrics.js' }] });
  assert.equal(r.ok, false);
  assert.ok(namesOf(r).includes('shared-is-leaf'));
});

test('shared-is-leaf：src/shared import 根目录冻结模块也算反向 → 红', () => {
  const r = analyze({ ...base, edges: [{ from: 'src/shared/data-dir.js', to: 'devices.js' }] });
  assert.equal(r.ok, false);
  assert.ok(namesOf(r).includes('shared-is-leaf'));
});

test('roots-are-sinks：组装根被别人 import → 红', () => {
  const a = analyze({ ...base, edges: [{ from: 'src/ops/metrics.js', to: 'server.js' }] });
  assert.equal(a.ok, false);
  assert.ok(namesOf(a).includes('roots-are-sinks'));

  // agent-appserver.js 是第二个组装根，只有 server.js 能引它。
  const b = analyze({ ...base, edges: [{ from: 'devices.js', to: 'agent-appserver.js' }] });
  assert.equal(b.ok, false);
  assert.ok(namesOf(b).includes('roots-are-sinks'));

  const ok = analyze({ ...base, edges: [{ from: 'server.js', to: 'agent-appserver.js' }] });
  assert.equal(ok.ok, true, 'server.js 引 agent-appserver.js 是唯一合法的那条边');
});

test('runtime-no-tooling：运行时 import scripts/ 或 test/ → 红', () => {
  for (const target of ['scripts/mutate.js', 'test/unit/x.test.mjs', 'e2e/lib/layout-audit.js']) {
    const r = analyze({ ...base, edges: [{ from: 'src/ops/metrics.js', to: target }] });
    assert.equal(r.ok, false, `import ${target} 应该被拒`);
    assert.ok(namesOf(r).includes('runtime-no-tooling'));
  }
});

test('logic-is-leaf：纯逻辑层 import 逻辑层之外的东西 → 红', () => {
  const r = analyze({ ...base, edges: [{ from: 'public/js/logic/unread.js', to: 'public/js/markdown.js' }] });
  assert.equal(r.ok, false);
  assert.ok(namesOf(r).includes('logic-is-leaf'));

  const ok = analyze({ ...base, edges: [{ from: 'public/js/logic/unread.js', to: 'public/js/logic/format.js' }] });
  assert.equal(ok.ok, true, '逻辑层内部互相 import 是允许的');
});

test('no-new-root-modules：根目录冒出冻结清单外的 .js → 红', () => {
  const r = analyze({ ...base, rootFiles: ['server.js', 'devices.js', 'brand-new-thing.js'] });
  assert.equal(r.ok, false);
  assert.ok(namesOf(r).includes('no-new-root-modules'));
  assert.match(JSON.stringify(r.problems), /brand-new-thing\.js/);
});

test('no-new-flat-frontend：public/js 直属冒出冻结清单外的 .js → 红', () => {
  const r = analyze({ ...base, publicFiles: ['public/js/app.js', 'public/js/brand-new.js'] });
  assert.equal(r.ok, false);
  assert.ok(namesOf(r).includes('no-new-flat-frontend'));
});

test('循环依赖 → 红，且报错里带出整条环', () => {
  const r = analyze({
    ...base,
    edges: [
      { from: 'src/ops/a.js', to: 'src/ops/b.js' },
      { from: 'src/ops/b.js', to: 'src/ops/c.js' },
      { from: 'src/ops/c.js', to: 'src/ops/a.js' },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(namesOf(r).includes('no-cycles'));
  const text = JSON.stringify(r.problems);
  for (const f of ['a.js', 'b.js', 'c.js']) assert.match(text, new RegExp(f.replace('.', '\\.')));
});

test('扫描面塌陷：一条边都没有 → 红，不能与「全部合规」同样是绿', () => {
  const r = analyze({ edges: [], rootFiles: ['server.js'], publicFiles: ['public/js/app.js'] });
  assert.equal(r.ok, false);
  assert.ok(namesOf(r).includes('scan-collapsed'));
});

// ---- parseImports：动态 import 不能成为绕过边界的后门 ----

test('parseImports 认静态 import / export-from / 裸 import', () => {
  const src = [
    "import a from './a.js';",
    "export { b } from './b.js';",
    "import './c.js';",
    "import { d } from '../d.js';",
  ].join('\n');
  assert.deepEqual(parseImports(src).sort(), ['../d.js', './a.js', './b.js', './c.js']);
});

test('parseImports 认行中间的动态 import —— 否则边界规则可被 await import() 绕过', () => {
  const src = "const m = await import('./sneaky.js');";
  assert.deepEqual(parseImports(src), ['./sneaky.js']);
});

test('parseImports 跳过整行注释——解释性散文最爱引用的就是调用形状本身', () => {
  // 实测过一次：config.js 的注释里写了 `import('../../server.js?t=…')` 解释为什么不能缓存，
  // 门禁立刻报出一条并不存在的循环依赖，而报错信息看起来和真的一模一样。
  const src = [
    "// 曾经在这里写过 import('../../server.js') 来解释为什么不行",
    ' * 块注释里的 await import("./ghost.js") 同样不算',
    "import real from './real.js';",
  ].join('\n');
  assert.deepEqual(parseImports(src), ['./real.js']);
});

test('parseImports 不把 import.meta 之类的词误当成 import 调用', () => {
  assert.deepEqual(parseImports('const x = import.meta.dirname;'), []);
  assert.deepEqual(parseImports('const s = "reimport(\'./no.js\')";'), [],
    '标识符中间的 import 不算——否则 reimport / preimport 这类命名会造出幽灵边');
});

test('findCycles 对无环图返回空', () => {
  const graph = new Map([['a', ['b']], ['b', ['c']], ['c', []]]);
  assert.deepEqual(findCycles(graph), []);
});

// ---- 三条反向断言：清单本身也会过期 ----
//
// 白名单类配置最常见的失效方式不是「漏了一条」，是「多了一条」：被豁免的东西早就不存在了，
// 而那条豁免继续替一个不再发生的情况开着口子。下面三条各盯一种过期形态。

test('反向：每条共享豁免都仍被后端真实 import，否则它只是一条死配置', () => {
  const { edges } = buildFromDisk();
  const backendConsumers = new Map();
  for (const { from, to } of edges) {
    if (!SHARED_ALLOWLIST.has(to)) continue;
    if (from.startsWith('public/js/')) continue; // 前端引前端不需要豁免
    if (!backendConsumers.has(to)) backendConsumers.set(to, []);
    backendConsumers.get(to).push(from);
  }
  for (const target of SHARED_ALLOWLIST.keys()) {
    assert.ok(
      backendConsumers.get(target)?.length > 0,
      `${target} 在 SHARED_ALLOWLIST 里，但已经没有任何后端文件 import 它了。`
      + '删掉这条豁免——留着等于替一个不再发生的情况开口子，而下一个人会以为它还在承重。',
    );
  }
});

test('反向：冻结清单里的每个名字都仍然存在', () => {
  const { rootFiles, publicFiles } = buildFromDisk();
  const publicNames = new Set(publicFiles.map(p => p.replace(/^public\/js\//, '')));

  const goneFromRoot = FROZEN_ROOT_MODULES.filter(name => !rootFiles.includes(name));
  assert.deepEqual(goneFromRoot, [],
    '这些名字还在根目录冻结清单里，但文件已经不在了。删掉它们——'
    + '过期的冻结名会让一个同名新文件被静默当成「存量」放行。');

  const goneFromPublic = FROZEN_PUBLIC_MODULES.filter(name => !publicNames.has(name));
  assert.deepEqual(goneFromPublic, [], '同上，public/js 冻结清单');
});

test('反向：真实仓库当前合规，且扫描面不是塌的', () => {
  const graph = buildFromDisk();
  assert.ok(graph.edges.length >= 20,
    `只扫到 ${graph.edges.length} 条 import 边，疑似提取正则失配——扫描面塌了不是「全部合规」`);
  const { ok, problems } = analyze(graph);
  assert.equal(ok, true, problems.map(p => `[${p.rule}] ${p.detail}`).join('\n'));
});
