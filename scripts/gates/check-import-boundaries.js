// scripts/gates/check-import-boundaries.js —— 模块边界守卫：静态解析项目内相对 import，
// 强制分层不变量 + 零循环依赖 + 「新代码不许落回平铺区」。
//
// 【为什么需要它】本仓根目录曾经平铺 27 个 .js、public/js/ 平铺 41 个，没有任何机器可读的
// 分层约定：eslint 没有 import 规则，三个门禁没一个管 import。而结构缠死是**渐进**的——
// 没有任何一次改动会让它当场变红，于是「下次再整理」可以无限推迟。这个脚本把「脑子里的
// 约定」变成一道会红的闸。
//
// 【当前阶段：存量已搬完，根目录只剩入口】24 个后端模块已按域进 src/{agent,auth,files,ops,
// sessions,shared}/，根目录只保留组装根 server.js 与两个工具配置。本门禁现在守四件事：
//   ① 域之间的依赖方向（layer-order，层序见 DOMAIN_RANK）；
//   ② 组装根不被反向 import（roots-are-sinks）；
//   ③ 前后端不互相渗透（两条 no-*，三个具名共享模块除外）；
//   ④ 不许再往根目录与 public/js/ 直属添新文件（no-new-*）。
//
// 【不引 madge】CI 不联网，而规则只需要静态相对 import 图，自实现足够。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 扫描根：后端 src/ 与前端 public/js/，外加根目录的组装根。
// tests/scripts 不设边界（工具与测试可跨域引用）。
const SCAN_DIRS = ['src', 'public/js'];

// ---------------------------------------------------------------------------
// 根目录白名单
// ---------------------------------------------------------------------------
// 根目录只许有组装根。**往里加名字等于把一个本该进 src/ 的新模块合法化**——
// 真要加，先回答它为什么进不了六个域里的任何一个。
// （两个工具配置 eslint.config.js / playwright.config.js 由 buildFromDisk 排除，
//   它们是构建期配置不是运行时模块，进不了依赖图。）
export const ROOT_ENTRYPOINTS = Object.freeze(['server.js']);

export const FROZEN_PUBLIC_MODULES = Object.freeze([
  'agent-activity.js', 'ansi-html.js', 'app.js', 'at-mention.js', 'attachments-ui.js',
  'cli-settings.js', 'client-encoding.js', 'composer-mode.js', 'confirm-dialog.js',
  'connection-banner.js', 'diff-lines.js', 'display-path.js', 'drawer-dirs.js',
  'file-diff-summary.js', 'header-chrome.js', 'health-diagnosis.js', 'html-escape.js',
  'icons.js', 'indexeddb-outbox.js', 'long-press.js', 'markdown-stream.js', 'markdown.js',
  'message-outbox.js', 'message-request.js', 'outbox-recovery.js', 'project-label.js',
  'random-id.js', 'recovery-state.js', 'slash-commands.js', 'socket-ack.js', 'sw.js',
  'thread-actions.js', 'thread-preferences.js', 'thread-status.js', 'token-usage.js',
  'tool-cards.js', 'transcript-stream.js', 'turn-outcome.js', 'ui-preferences.js',
  'view-routing.js', 'workspace-panel.js',
]);

// 两个组装根。它们只能被列出的那一方 import，谁都不许反过来引它们。
//
// 【键必须是仓库相对路径，且有反向断言盯着它们仍存在】搬家时这里最容易腐烂：
// 文件从根目录进了 src/agent/ 之后，'agent-appserver.js' 这个键再也匹配不到任何一条边，
// 于是 roots-are-sinks 一个目标都没有——而它照样遍历、照样比对、照样报绿。
// 「规则失效」与「全部合规」在输出上完全一样，这是清单型门禁的典型死法。
export const ASSEMBLY_ROOTS = Object.freeze({
  'server.js': [],                                    // 顶层入口，任何人不得 import
  'src/agent/agent-appserver.js': ['server.js'],      // 第二组装根，只有 server.js 能引
});

// 前后端共享：**唯一**允许后端 import 前端的三个具名文件。
// 不开 `public/js/shared/` 这类目录级后门——那会让「再共享一个」变成零成本，
// 而每多一个共享模块，前后端的耦合面就多一处，且耦合方向是反的。
export const SHARED_ALLOWLIST = new Map([
  ['public/js/cli-settings.js',
    '权限预设与 turn overrides 的归一化：server.js 与 agent-appserver.js 消费同一份，浏览器也照它渲染。'
    + '两侧各写一份必然分叉成「面板显示的策略 ≠ 实际下发的策略」'],
  ['public/js/token-usage.js',
    'token 用量的字段归一：src/ops/statusline.js 消费。该文件注释已记过一次 camelCase→snake_case 漂移'
    + '导致静默显示 0 的事故，那正是两份实现的代价'],
  ['public/js/thread-actions.js',
    'SCHEMA_MISMATCH 正则：运行时兜底（前端渲染那条错误）与启动自检（src/ops/doctor-checks.js）'
    + '必须认同一个形态，否则 doctor 报绿而手机上弹 no such table。'
    + '（这条曾经被删过一次——当时它的唯一消费者是 scripts/doctor.js，而 scripts/ 不在扫描面内，'
    + '于是豁免对应不到任何真实的边、成了死配置。判定层搬进 src/ 之后它才真正承重。）'],
]);

// ---------------------------------------------------------------------------
// import 提取
// ---------------------------------------------------------------------------
// 两条正则分工明确：
//   · 静态 import / export-from **行首锚定** —— 它们在语法上只能出现在语句开头。
//   · 动态 `import('...')` **不锚定行首** —— 它可以出现在行中任意位置
//     （`const m = await import('./x.js')`）。不单列这一条的话，
//     **边界规则可以被动态 import 整个绕过**，而绕过之后一切照常绿。
// 静态 import 的说明符只能是普通字符串字面量（``import x from `./y``` 是语法错误），
// 所以这一条不认反引号。引号用捕获组回引，与动态那条对齐成同样的 match[2]。
const STATIC_IMPORT_RE =
  /(?:^|\n)\s*(?:import\s[^'"]*?from\s*|export\s[^'"]*?from\s*|import\s*)(['"])([^'"]+)\1/g;
// 前瞻 `(?<![.\w])` 挡住 `import.meta` 与 `reimport(` 这类——不挡的话会造出幽灵边，
// 而幽灵边指向的文件通常不存在，于是报错信息会把人引向一个根本不存在的问题。
//
// 【反引号那一支不能漏，2026-09-15 补】上一版只认 `['"]`，于是
// ``await import(`./x.js`)`` 对这道闸完全不可见——而这道闸加动态 import 分支的**全部理由**
// 就是防「边界规则可以被 await import() 绕过」。少认一种字面量等于那个绕过口一直开着。
// 带插值的 ``import(`./x.js?t=${Date.now()}`)`` 也认：`${…}` 里没有引号和反引号，
// 整段会被捕获，而 resolveSpecifier 按 `?` 截断后剩下的正是那个静态前缀。
const DYNAMIC_IMPORT_RE = /(?<![.\w])import\s*\(\s*(['"`])([^'"`]+)\1/g;

/**
 * 去掉整行注释后再提取。
 *
 * 【为什么必须去】提取器工作在裸文本上，而解释性散文最爱引用的就是调用形状本身——
 * 本仓实测过一次：config.js 的注释里写了一句 `import('../../server.js?t=…')` 来解释
 * 为什么不能缓存，门禁立刻报出一条 src/ops/config.js → server.js 的循环依赖。
 * 那条边不存在，而报错信息看起来和真的一模一样。
 *
 * 判据是**整行注释**（与 public-shell-guard 同款），不做完整词法分析：散文活在整行注释里，
 * 而 `'https://…'` 这类字符串里的 `//` 不会出现在行首，不会被误伤。
 */
function stripCommentLines(source) {
  return String(source)
    .split('\n')
    .map(line => {
      const trimmed = line.trim();
      return (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) ? '' : line;
    })
    .join('\n');
}

export function parseImports(source) {
  const code = stripCommentLines(source);
  const found = [];
  for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    for (const match of code.matchAll(re)) found.push(match[2]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------
const isFrontend = p => p.startsWith('public/js/');
const isLogicLayer = p => p.startsWith('public/js/logic/');
const isBackendSrc = p => p.startsWith('src/');
const isRootModule = p => ROOT_ENTRYPOINTS.includes(p);
const isBackend = p => isBackendSrc(p) || isRootModule(p);
const isTooling = p => p.startsWith('scripts/') || p.startsWith('test/') || p.startsWith('e2e/');

/**
 * 后端域的层序。数字大的可以引数字小的，同层互引放行（真成环由 no-cycles 抓）。
 *
 * 【这张表是量出来的，不是设计出来的】搬家当天把 src/ 的全部跨域边打出来统计，
 * 得到的就是下面这个顺序，一条反例都没有。所以它不是对未来的约束，是把**已经成立的
 * 事实**钉住——这样它从第一天起就是绿的，而任何一次方向反转都会当场红。
 * 反过来，凭空设计一套理想层序的下场是它落地当天就红一片，然后被人加豁免加到失效。
 *
 * 实测的跨域边（域 → 域）：
 *   server.js → agent/auth/files/ops/sessions/shared   agent → files/sessions/shared
 *   auth → files    ops → files/shared    sessions → files/shared    files → （无）
 */
export const DOMAIN_RANK = Object.freeze({
  'src/shared': 0,    // 零 IO 零跨域叶子
  'src/files': 1,     // 路径归一与文件安全，被上面各域共用
  'src/auth': 2,
  'src/ops': 2,
  'src/sessions': 2,
  'src/agent': 3,     // app-server 运行时，组装 sessions/files
});
// server.js 刻意不进这张表：它作为**来源**可以引任何域（组装根的本分），
// 作为**目标**由 roots-are-sinks 全面禁止。放进来只会让同一条违规被两条规则各报一次。

const rankOf = p => DOMAIN_RANK[p.match(/^(src\/[^/]+)\//)?.[1]];

export const BOUNDARY_RULES = Object.freeze([
  {
    name: 'frontend-no-backend',
    describe: '前端（public/js）不得 import 后端（src/ 或根目录模块）',
    violates: (from, to) => isFrontend(from) && isBackend(to),
  },
  {
    name: 'backend-no-frontend',
    describe: '后端不得 import 前端，三个具名共享模块除外（见 SHARED_ALLOWLIST）',
    violates: (from, to) => isBackend(from) && isFrontend(to) && !SHARED_ALLOWLIST.has(to),
  },
  {
    name: 'layer-order',
    describe: '后端域只能引层序不高于自己的域（src/shared 因此是叶子）',
    violates: (from, to) => {
      const a = rankOf(from);
      const b = rankOf(to);
      return a !== undefined && b !== undefined && b > a;
    },
  },
  {
    name: 'roots-are-sinks',
    describe: '组装根（server.js / agent-appserver.js）只能被明确许可的一方 import',
    violates: (from, to) => Object.hasOwn(ASSEMBLY_ROOTS, to) && !ASSEMBLY_ROOTS[to].includes(from),
  },
  {
    name: 'runtime-no-tooling',
    describe: '运行时代码不得 import scripts/ test/ e2e/（维护者工具与测试）',
    violates: (from, to) => !isTooling(from) && isTooling(to),
  },
  {
    name: 'logic-is-leaf',
    describe: 'public/js/logic 是纯逻辑层，只能 import 同层（数据进数据出，不碰 DOM/socket）',
    violates: (from, to) => isLogicLayer(from) && !isLogicLayer(to),
  },
]);

// ---------------------------------------------------------------------------
// 循环依赖
// ---------------------------------------------------------------------------
export function findCycles(graph) {
  const cycles = [];
  const state = new Map(); // 0=未访问 1=在栈上 2=已完成
  const stack = [];

  const visit = node => {
    if (state.get(node) === 2) return;
    if (state.get(node) === 1) {
      cycles.push([...stack.slice(stack.indexOf(node)), node]);
      return;
    }
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) visit(next);
    stack.pop();
    state.set(node, 2);
  };

  for (const node of graph.keys()) visit(node);
  return cycles;
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------
export function analyze({ edges = [], rootFiles = [], publicFiles = [] } = {}) {
  const problems = [];

  // 扫到 0 条边与「全部合规」在断言上完全一样，而前者意味着这道闸已经失明
  // （扫描根改名、目录被移走、提取正则失配都会走到这里）。
  if (edges.length === 0) {
    problems.push({ rule: 'scan-collapsed', detail: '一条项目内 import 都没解析出来——扫描面塌陷，不是「全部合规」' });
  }

  for (const { from, to } of edges) {
    for (const rule of BOUNDARY_RULES) {
      if (rule.violates(from, to)) {
        problems.push({ rule: rule.name, from, to, detail: `${from} → ${to}：${rule.describe}` });
      }
    }
  }

  for (const file of rootFiles) {
    if (!ROOT_ENTRYPOINTS.includes(file)) {
      problems.push({
        rule: 'no-new-root-modules',
        detail: `${file} 落在了根目录。根目录只放组装根 server.js，`
          + `模块请进 src/ 的六个域之一：${Object.keys(DOMAIN_RANK).map(d => d.slice(4)).join(' / ')}。`
          + '真要放根上，先回答它为什么进不了任何一个域',
      });
    }
  }

  for (const file of publicFiles) {
    const name = file.replace(/^public\/js\//, '');
    if (!FROZEN_PUBLIC_MODULES.includes(name)) {
      problems.push({
        rule: 'no-new-flat-frontend',
        detail: `${file} 是 public/js/ 直属新增的模块。那一层是冻结区：`
          + '纯逻辑进 public/js/logic/（数据进数据出），DOM 胶水进 public/js/app/',
      });
    }
  }

  const graph = new Map();
  for (const { from, to } of edges) {
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from).push(to);
  }
  for (const cycle of findCycles(graph)) {
    problems.push({ rule: 'no-cycles', detail: `循环依赖：${cycle.join(' → ')}` });
  }

  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// 从磁盘构图
// ---------------------------------------------------------------------------
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

/**
 * 把 import 说明符解析成项目相对路径；解析不到项目内文件时返回 null（第三方包、node: 内置）。
 *
 * 【`/js/...` 这一支不能漏】浏览器里的模块说明符是相对**站点根**的绝对路径，而
 * public/ 就是站点根。本仓前端两种写法混用：多数文件写 `./x.js`，而 app.js 与
 * workspace-panel.js 写 `/js/x.js`。只认 `.` 开头的话，这两个文件的所有 import 边
 * 对门禁完全不可见——偏偏 app.js 是最大的那个前端文件，它违规了也不会红。
 */
function resolveSpecifier(fromAbs, specifier) {
  const path = specifier.split('?')[0];
  if (path.startsWith('/js/') || path.startsWith('/vendor/')) return `public${path}`;
  if (!path.startsWith('.')) return null;
  return relative(ROOT, resolve(dirname(fromAbs), path)).split('\\').join('/');
}

export function buildFromDisk(root = ROOT) {
  const files = [
    ...SCAN_DIRS.flatMap(dir => walk(join(root, dir))),
    ...ROOT_ENTRYPOINTS.map(name => join(root, name)).filter(existsSync),
  ];

  const edges = [];
  for (const abs of files) {
    const from = relative(root, abs).split('\\').join('/');
    for (const specifier of parseImports(readFileSync(abs, 'utf8'))) {
      const to = resolveSpecifier(abs, specifier);
      if (to && !to.startsWith('..')) edges.push({ from, to });
    }
  }

  return {
    edges,
    rootFiles: readdirSync(root)
      .filter(name => name.endsWith('.js') && !/^(eslint|playwright)\.config\.js$/.test(name)),
    publicFiles: readdirSync(join(root, 'public', 'js'), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
      .map(entry => `public/js/${entry.name}`),
  };
}

if (process.argv[1] && process.argv[1].endsWith('check-import-boundaries.js')) {
  const { ok, problems } = analyze(buildFromDisk());
  if (!ok) {
    console.error('❌ 模块边界检查未通过：\n');
    for (const problem of problems) console.error(`  [${problem.rule}] ${problem.detail}\n`);
    process.exit(1);
  }
  console.log('✅ 模块边界与依赖方向合规');
}
