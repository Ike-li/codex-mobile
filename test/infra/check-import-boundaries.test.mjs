// test/infra/check-import-boundaries.test.mjs —— 模块边界门禁自身的每条规则各红一次。
//
// 为什么要逐条测：这道闸守的是「结构别缠死」，而结构缠死是**渐进**的——没有任何一次
// 改动会让它当场变红。一条写错的规则因此可以静默地永远绿着，而它占着「边界有人管」
// 这个位置。所以每条规则都必须被证明能红一次，扫描面塌陷也要单独会红。
//
// 用真实的 analyze / parseImports，不手写 stub。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyze, parseImports, findCycles, buildFromDisk,
  BOUNDARY_RULES, SHARED_ALLOWLIST, ROOT_ENTRYPOINTS, FROZEN_PUBLIC_MODULES,
  ASSEMBLY_ROOTS, DOMAIN_RANK,
} from '../../scripts/gates/check-import-boundaries.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 一份最小的合规仓库形状，各用例在它上面只改一处。
const base = {
  edges: [
    { from: 'server.js', to: 'src/auth/devices.js' },
    { from: 'src/ops/metrics.js', to: 'src/shared/data-dir.js' },
    { from: 'public/js/app.js', to: 'public/js/logic/unread.js' },
  ],
  rootFiles: ['server.js'],
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

test('frontend-no-backend：前端 import 根目录组装根也算 → 红', () => {
  const r = analyze({ ...base, edges: [{ from: 'public/js/app.js', to: 'server.js' }] });
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
      { from: 'src/agent/agent-appserver.js', to: 'public/js/cli-settings.js' },
      { from: 'src/ops/statusline.js', to: 'public/js/token-usage.js' },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems, null, 2));
});

test('layer-order：低层域反向 import 高层域 → 红', () => {
  // src/shared 是 0 层，引任何别的域都是反向。
  const r = analyze({ ...base, edges: [{ from: 'src/shared/data-dir.js', to: 'src/ops/metrics.js' }] });
  assert.equal(r.ok, false);
  assert.ok(namesOf(r).includes('layer-order'));

  // files(1) 引 ops(2) 同样是反向——这条比 shared 那条更容易被写出来，
  // 因为「上传时顺手记个 metric」看上去完全合理。
  const s = analyze({ ...base, edges: [{ from: 'src/files/uploads.js', to: 'src/ops/metrics.js' }] });
  assert.equal(s.ok, false);
  assert.ok(namesOf(s).includes('layer-order'));
});

test('layer-order：顺向与同层放行', () => {
  const down = analyze({ ...base, edges: [{ from: 'src/agent/x.js', to: 'src/files/y.js' }] });
  assert.equal(down.ok, true, 'agent(3) → files(1) 是顺向', JSON.stringify(down.problems));

  const same = analyze({ ...base, edges: [{ from: 'src/ops/x.js', to: 'src/auth/y.js' }] });
  assert.equal(same.ok, true, '同层互引放行，真成环交给 no-cycles');
});

test('layer-order：层序表覆盖 src/ 下的每一个域，不许有域落在表外', () => {
  // 落在表外的域 rankOf 返回 undefined，规则直接跳过它——**新建一个域等于给自己开了
  // 一扇不受层序管的门**，而它看起来和别的域一模一样。
  const { edges } = buildFromDisk();
  const domains = new Set();
  for (const { from, to } of [...edges.map(e => ({ from: e.from, to: e.to }))]) {
    for (const p of [from, to]) {
      const m = p.match(/^(src\/[^/]+)\//);
      if (m) domains.add(m[1]);
    }
  }
  assert.ok(domains.size >= 6, `只发现 ${domains.size} 个后端域，扫描面疑似塌陷`);
  for (const d of domains) {
    assert.ok(d in DOMAIN_RANK, `${d} 没有出现在 DOMAIN_RANK 里，layer-order 管不到它`);
  }
});

test('roots-are-sinks：组装根被别人 import → 红', () => {
  const a = analyze({ ...base, edges: [{ from: 'src/ops/metrics.js', to: 'server.js' }] });
  assert.equal(a.ok, false);
  assert.ok(namesOf(a).includes('roots-are-sinks'));

  // agent-appserver.js 是第二个组装根，只有 server.js 能引它。
  const b = analyze({ ...base, edges: [{ from: 'src/auth/devices.js', to: 'src/agent/agent-appserver.js' }] });
  assert.equal(b.ok, false);
  assert.ok(namesOf(b).includes('roots-are-sinks'));

  const ok = analyze({ ...base, edges: [{ from: 'server.js', to: 'src/agent/agent-appserver.js' }] });
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

test('no-new-root-modules：根目录冒出 server.js 之外的 .js → 红', () => {
  const r = analyze({ ...base, rootFiles: ['server.js', 'brand-new-thing.js'] });
  assert.equal(r.ok, false);
  assert.ok(namesOf(r).includes('no-new-root-modules'));
  assert.match(JSON.stringify(r.problems), /brand-new-thing\.js/);
  assert.match(JSON.stringify(r.problems), /agent|shared/, '报错要点出该往哪个域放，不能只说「不许」');
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

test('parseImports 认反引号形态的动态 import —— 少认一种字面量就是少堵一个绕过口', () => {
  // 2026-09-15：搬家时才发现这个洞。上一版只认 ['"]，而本仓 test/ 里大量用
  // ``import(`../../x.js?t=${Date.now()}`)`` 破缓存——同样的写法出现在 src/ 里，
  // 这道闸一条边都看不见。带插值的也要认：`${…}` 里没有引号，整段会被捕获，
  // 而 resolveSpecifier 按 `?` 截断后剩下的正是那个静态前缀。
  assert.deepEqual(parseImports('const m = await import(`./tpl.js`);'), ['./tpl.js']);
  assert.deepEqual(parseImports('await import(`../../server.js?t=${Date.now()}`);'),
    ['../../server.js?t=${Date.now()}'], '原样返回，截断交给 resolveSpecifier');
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

// ---- 四条反向断言：清单本身也会过期 ----
//
// 白名单类配置最常见的失效方式不是「漏了一条」，是「多了一条」：被豁免的东西早就不存在了，
// 而那条豁免继续替一个不再发生的情况开着口子。下面四条各盯一种过期形态。

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

test('反向：白名单里的每个名字都仍然存在', () => {
  const { rootFiles, publicFiles } = buildFromDisk();
  const publicNames = new Set(publicFiles.map(p => p.replace(/^public\/js\//, '')));

  const goneFromRoot = ROOT_ENTRYPOINTS.filter(name => !rootFiles.includes(name));
  assert.deepEqual(goneFromRoot, [],
    '这些名字还在根目录白名单里，但文件已经不在了。删掉它们——'
    + '过期的白名单会让一个同名新文件被静默放行。');

  const goneFromPublic = FROZEN_PUBLIC_MODULES.filter(name => !publicNames.has(name));
  assert.deepEqual(goneFromPublic, [], '同上，public/js 冻结清单');
});

test('反向：ASSEMBLY_ROOTS 的键必须是真实存在的文件', () => {
  // 【这条是 2026-09-15 搬家当天补的，因为它当场抓到了一次真实失效】
  // 24 个后端模块从根目录进 src/ 之后，ASSEMBLY_ROOTS 里 'agent-appserver.js' 这个键
  // 再也匹配不到任何一条边——roots-are-sinks 于是一个目标都没有。而门禁照样遍历、
  // 照样比对、照样打印「✅ 模块边界与依赖方向合规」。
  //
  // scan-collapsed 抓不到这种：它只在**零条边**时触发，而这里边一条不少，
  // 只是规则的键全部失配。**部分塌陷比全塌陷更危险**，因为它连数字都不异常。
  const { edges } = buildFromDisk();
  const targets = new Set(edges.map(e => e.to));
  for (const [root, allowed] of Object.entries(ASSEMBLY_ROOTS)) {
    assert.ok(existsSync(join(ROOT_DIR, root)), `ASSEMBLY_ROOTS 的键 ${root} 在磁盘上不存在`);
    for (const importer of allowed) {
      assert.ok(existsSync(join(ROOT_DIR, importer)),
        `ASSEMBLY_ROOTS['${root}'] 里许可的 importer ${importer} 不存在`);
      assert.ok(targets.has(root),
        `没有任何一条边指向 ${root}，这条许可现在是空转的——要么它已经不是组装根了，要么扫描面失配`);
    }
  }
});

test('反向：真实仓库当前合规，且扫描面不是塌的', () => {
  const graph = buildFromDisk();
  assert.ok(graph.edges.length >= 20,
    `只扫到 ${graph.edges.length} 条 import 边，疑似提取正则失配——扫描面塌了不是「全部合规」`);
  const { ok, problems } = analyze(graph);
  assert.equal(ok, true, problems.map(p => `[${p.rule}] ${p.detail}`).join('\n'));
});

test('浏览器绝对路径说明符（/js/…）也要被解析，否则前端半数文件对门禁不可见', () => {
  // 本仓前端两种写法混用：多数文件写 './x.js'，而 app.js 与 workspace-panel.js 写
  // '/js/x.js'（浏览器里说明符是相对站点根的，而 public/ 就是站点根）。
  // 只认 '.' 开头的话，那两个文件的所有 import 边门禁完全看不见——而 app.js
  // 恰恰是最大的那个前端文件。
  const { edges } = buildFromDisk();
  const fromApp = edges.filter(e => e.from === 'public/js/app.js');
  assert.ok(fromApp.length > 10, `app.js 只解析出 ${fromApp.length} 条 import 边，绝对路径那一支失配了`);
  for (const e of fromApp) {
    assert.match(e.to, /^public\/js\//, `解析结果没落回 public/ 下：${e.to}`);
  }
});
