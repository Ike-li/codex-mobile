// test/infra/ci-workflow.test.mjs —— CI 门禁自身的契约测试。
//
// 为什么要给 workflow 写测试：门禁退化是静默的。2026-08/09 连续四次 CI 失败
// （含每晚定时任务）全是同一个形状 —— `test (22)` 挂掉，矩阵默认的 fail-fast
// 顺手取消了 `test (20)`，而 protocol-check、lint、覆盖率、E2E 全部只在 Node 20
// 那条腿上跑。GitHub 上看到的是一个红叉，实际情况是所有真门禁一条都没执行。
// 同期 security job 常绿，因为它显式吞掉了失败。
//
// 这些断言是关键字层面的，所以直接对 YAML 文本断言，不引入 YAML 解析器
// （js-yaml 在本仓库只是 eslint 的传递依赖，随时可能消失）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'test.yml');
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// 把一条命令里的 `npm run X` 与 `npm test` 递归展开成最终命令文本。
// 与 gate-wiring.test.mjs 里那份同源：`npm test` 是内置别名、不写 run，漏掉它会让
// 挂在 test 上的门禁（check-test-summary.js）被误判成没接线。
function expandCommand(command, seen = new Set()) {
  return String(command ?? '')
    .replace(/\bnpm run ([A-Za-z0-9:_-]+)/g, (_, ref) => (seen.has(ref) ? '' : expandCommand(pkg.scripts[ref], new Set([...seen, ref]))))
    .replace(/\bnpm test\b/g, () => (seen.has('test') ? '' : expandCommand(pkg.scripts.test, new Set([...seen, 'test']))));
}

const gatesIn = text => new Set([...String(text).matchAll(/scripts\/gates\/([A-Za-z0-9._-]+)/g)].map(m => m[1]));

// gate-wiring.test.mjs 守的是「门禁挂在 test:ci 上」。但 **workflow 不跑 test:ci** ——
// 它把各段拆成独立 step 逐条写。于是「加进 test:ci」与「CI 上真的会跑」是两件事，
// 而两者看起来完全一样：本地 `npm run test:ci` 全绿，CI 也全绿，但那道闸一次都没执行。
// 这条断言就是把这个缺口堵上——它是 gate-wiring 的必要补充，不是重复。
test('test:ci 上挂着的每个门禁，在 workflow 里也真的会被执行', () => {
  const inCheckChain = gatesIn(expandCommand(pkg.scripts['test:ci']));
  const inWorkflow = gatesIn([...workflow.matchAll(/^\s*run:\s*(.+)$/gm)]
    .map(([, command]) => expandCommand(command))
    .join('\n'));

  // 扫到 0 个与「全部合规」在断言上无法区分——展开器失配、门禁目录改名都会走到这里。
  assert.ok(inCheckChain.size > 0, 'test:ci 里一个门禁都没解析出来——展开器失配，这条断言已失明');

  const missing = [...inCheckChain].filter(gate => !inWorkflow.has(gate)).sort();
  assert.deepEqual(
    missing,
    [],
    '这些门禁挂在 test:ci 上，但 workflow 的 run: 步骤里没有任何一条会执行到它们。'
    + 'workflow 是逐步骤写的、不跑 test:ci，所以只改 test:ci 等于这道闸在 CI 上根本不跑——'
    + '而本地跑 test:ci 是绿的，CI 也是绿的，两边都看不出来。给它加一个 step。',
  );
});

test('开发分支 dev 和主分支 master 的 push 都触发验证', () => {
  const push = workflow.match(/^ {2}push:\n([\s\S]*?)(?=^ {2}\w|^jobs:)/m)?.[1];
  assert.ok(push, '找不到 push 触发器');
  const branches = push.match(/branches:\s*\[([^\]]+)\]/)?.[1].split(',').map(s => s.trim());
  assert.ok(branches?.includes('master'), 'master 合并后必须验证');
  assert.ok(branches?.includes('dev'), '开发只在 dev 上进行，不能漏掉它的 push 门禁');
});

test('Node 版本矩阵关闭 fail-fast，一条腿失败不会取消另一条腿上的门禁', () => {
  assert.match(
    workflow,
    /strategy:\s*\n(?:\s*#.*\n)*\s*fail-fast:\s*false/,
    'matrix 缺少 fail-fast: false —— Node 22 失败会取消 Node 20，而 lint/protocol-check/覆盖率/E2E 只在 Node 20 上跑',
  );
});

test('没有任何步骤用 continue-on-error 把失败吞掉', () => {
  assert.doesNotMatch(
    workflow,
    /continue-on-error:\s*true/,
    'continue-on-error: true 会让步骤永远绿 —— 要么让它成为真门禁，要么把它挪出门禁 job',
  );
});

test('生产依赖的高危漏洞是阻断门禁', () => {
  assert.match(
    workflow,
    /npm audit --omit=dev --audit-level=high/,
    '必须对生产依赖单独跑阻断式 audit：本服务的传输层是 socket.io，运行时依赖的漏洞直接面向网络',
  );
});

test('全量 audit 即使不阻断，报告也必须留存为产物', () => {
  const advisory = /npm audit --json > audit-report\.json/.test(workflow);
  if (!advisory) return; // 没有非阻断的全量 audit 就没有这条约束
  assert.match(
    workflow,
    /path:\s*audit-report\.json/,
    '生成了 audit-report.json 却没有 upload-artifact —— 报告随容器销毁，等于没跑',
  );
});

test('覆盖率退化门禁不只在 pull_request 上生效', () => {
  const deltaStep = workflow.match(/- name: Check coverage delta\n(?:.*\n)*?\s*run: .*check-coverage-delta\.js/);
  assert.ok(deltaStep, 'workflow 里找不到 Check coverage delta 步骤');
  assert.doesNotMatch(
    deltaStep[0],
    /github\.event_name == 'pull_request'/,
    '直接 push 到 master 时会跳过 2pp 退化门禁 —— 而 fast-forward 合并走的正是 push 路径',
  );
});

// playwright.config.js 里每加一个 project，CI 就要多装一个浏览器引擎。这两处是分开的
// 文件，改一处漏一处的症状是 E2E 报 "Executable doesn't exist" —— 那句报错读起来像
// 环境坏了，不像少装了浏览器，于是排查方向会先跑偏。
//
// 名单从 config 派生而不是写死，所以将来加 firefox project 也会被自动守住。
test('CI 安装的浏览器覆盖 playwright.config.js 声明的全部引擎', () => {
  const config = readFileSync(join(ROOT, 'playwright.config.js'), 'utf8');

  // project 的引擎由 devices[...] 决定：Pixel 5 → chromium，iPhone 13 → webkit。
  const engines = new Set();
  for (const [, device] of config.matchAll(/devices\['([^']+)'\]/g)) {
    if (/^Pixel|^Galaxy|Chrome/i.test(device)) engines.add('chromium');
    else if (/^iPhone|^iPad|Safari/i.test(device)) engines.add('webkit');
    else if (/Firefox/i.test(device)) engines.add('firefox');
  }
  assert.ok(engines.size > 0, '没能从 playwright.config.js 解析出任何引擎，解析失配了');

  const install = /npx playwright install ([^\n]*)/.exec(workflow);
  assert.ok(install, 'CI 里找不到 playwright install 步骤');
  const installed = install[1].trim().split(/\s+/);

  const missing = [...engines].filter(e => !installed.includes(e));
  assert.deepEqual(missing, [],
    `playwright.config.js 声明了这些引擎的 project，但 CI 没装：${missing.join(', ')}。`
    + `\nCI 当前装的是：${installed.join(' ')}`
    + '\n漏装时 E2E 会报 "Executable doesn\'t exist"，而那句话不会告诉你少装了什么。');
});
