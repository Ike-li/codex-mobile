// scripts/gates/check-import-boundaries.js —— 模块边界守卫：静态解析项目内相对 import，
// 强制分层不变量 + 零循环依赖 + 「新代码不许落回平铺区」。
//
// 【为什么需要它】本仓根目录曾经平铺 25 个 .js、public/js/ 平铺 41 个，没有任何机器可读的
// 分层约定：eslint 没有 import 规则，三个门禁没一个管 import。而结构缠死是**渐进**的——
// 没有任何一次改动会让它当场变红，于是「下次再整理」可以无限推迟。这个脚本把「脑子里的
// 约定」变成一道会红的闸。
//
// 【当前阶段：存量冻结，新代码进新分层】根目录那 25 个与 public/js/ 那 41 个是**冻结区**，
// 本门禁不要求它们搬家，只要求：① 它们之间的既有依赖方向不许变坏；② 不许再往这两个平铺区
// 添新文件（no-new-root-modules / no-new-flat-frontend）。新代码去 src/ 与 public/js/{logic,app}/。
//
// 【不引 madge】CI 不联网，而规则只需要静态相对 import 图，自实现足够。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 扫描根：新分层两处 + 冻结区两处。tests/scripts 不设边界（工具与测试可跨域引用）。
const SCAN_DIRS = ['src', 'public/js'];

// ---------------------------------------------------------------------------
// 冻结清单
// ---------------------------------------------------------------------------
// 这两份名单是「存量」的定义。它们只减不增：文件删了要同步删名字（有反向断言盯着），
// 而**往里加名字等于把一个本该进 src/ 的新模块合法化**——真要加，先问为什么它进不了 src/。
export const FROZEN_ROOT_MODULES = Object.freeze([
  'agent-appserver.js', 'app-server-host.js', 'app-server-transport.js', 'approval-broker.js',
  'audit-log.js', 'devices.js', 'file-search.js', 'file-security.js', 'git-workspace.js',
  'input-parts.js', 'message-receipt-ledger.js', 'needs-you-registry.js', 'network-address.js',
  'push-sender.js', 'rpc-log-redaction.js', 'sanitizer.js', 'server-security.js', 'server.js',
  'statusline.js', 'text-utils.js', 'thread-history.js', 'thread-registry.js', 'uploads.js',
  'user-inputs.js', 'workdir-allowlist.js',
]);

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

// 两个组装根。它们只能被 EXPLICIT 那一侧 import，谁都不许反过来引它们。
const ASSEMBLY_ROOTS = Object.freeze({
  'server.js': [],                       // 顶层入口，任何人不得 import
  'agent-appserver.js': ['server.js'],   // 第二组装根，只有 server.js 能引
});

// 前后端共享：**唯一**允许后端 import 前端的三个具名文件。
// 不开 `public/js/shared/` 这类目录级后门——那会让「再共享一个」变成零成本，
// 而每多一个共享模块，前后端的耦合面就多一处，且耦合方向是反的。
export const SHARED_ALLOWLIST = new Map([
  ['public/js/cli-settings.js',
    '权限预设与 turn overrides 的归一化：server.js 与 agent-appserver.js 消费同一份，浏览器也照它渲染。'
    + '两侧各写一份必然分叉成「面板显示的策略 ≠ 实际下发的策略」'],
  ['public/js/token-usage.js',
    'token 用量的字段归一：statusline.js 消费。该文件注释已记过一次 camelCase→snake_case 漂移'
    + '导致静默显示 0 的事故，那正是两份实现的代价'],
]);

// 【为什么 public/js/thread-actions.js 不在上面】它确实被 scripts/doctor.js import
// （共享 SCHEMA_MISMATCH 正则），但 scripts/ 不在扫描面内，且「工具 import 运行时」
// 本来就是合法方向——runtime-no-tooling 是单向的。给它加一条豁免不会拦住任何东西，
// 只会变成一条谁也不敢删的死配置：反向断言（豁免必须仍被真实 import）对它恒假。

// ---------------------------------------------------------------------------
// import 提取
// ---------------------------------------------------------------------------
// 两条正则分工明确：
//   · 静态 import / export-from **行首锚定** —— 它们在语法上只能出现在语句开头。
//   · 动态 `import('...')` **不锚定行首** —— 它可以出现在行中任意位置
//     （`const m = await import('./x.js')`）。不单列这一条的话，
//     **边界规则可以被动态 import 整个绕过**，而绕过之后一切照常绿。
const STATIC_IMPORT_RE =
  /(?:^|\n)\s*(?:import\s[^'"]*?from\s*|export\s[^'"]*?from\s*|import\s*)['"]([^'"]+)['"]/g;
// 前瞻 `(?<![.\w])` 挡住 `import.meta` 与 `reimport(` 这类——不挡的话会造出幽灵边，
// 而幽灵边指向的文件通常不存在，于是报错信息会把人引向一个根本不存在的问题。
const DYNAMIC_IMPORT_RE = /(?<![.\w])import\s*\(\s*['"]([^'"]+)['"]/g;

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
    for (const match of code.matchAll(re)) found.push(match[1]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------
const isFrontend = p => p.startsWith('public/js/');
const isLogicLayer = p => p.startsWith('public/js/logic/');
const isBackendSrc = p => p.startsWith('src/');
const isRootModule = p => FROZEN_ROOT_MODULES.includes(p);
const isBackend = p => isBackendSrc(p) || isRootModule(p);
const isTooling = p => p.startsWith('scripts/') || p.startsWith('test/') || p.startsWith('e2e/');

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
    name: 'shared-is-leaf',
    describe: 'src/shared 是叶子层，不得反向 import 其他后端域',
    violates: (from, to) => from.startsWith('src/shared/')
      && ((isBackendSrc(to) && !to.startsWith('src/shared/')) || isRootModule(to)),
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
    if (!FROZEN_ROOT_MODULES.includes(file)) {
      problems.push({
        rule: 'no-new-root-modules',
        detail: `${file} 是根目录新增的模块。根目录是冻结区，新代码请落 src/{shared,ops,files,sessions}/。`
          + '真要放根上，先回答它为什么进不了 src/',
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

/** 把 import 说明符解析成项目相对路径；解析不到项目内文件时返回 null（第三方包、node: 内置）。 */
function resolveSpecifier(fromAbs, specifier) {
  if (!specifier.startsWith('.')) return null;
  const abs = resolve(dirname(fromAbs), specifier.split('?')[0]);
  return relative(ROOT, abs).split('\\').join('/');
}

export function buildFromDisk(root = ROOT) {
  const files = [
    ...SCAN_DIRS.flatMap(dir => walk(join(root, dir))),
    ...FROZEN_ROOT_MODULES.map(name => join(root, name)).filter(existsSync),
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
