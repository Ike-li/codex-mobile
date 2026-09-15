// test/unit/setup.test.mjs —— 装机向导的决策面。
//
// 向导的危险不在「装不上」，在**替用户做了他不知道的决定**：把家目录当成工作区、
// 在没有 TTY 的地方悄悄走完交互分支、覆盖掉一份还在用的配置。所以这里几乎全是
// 「什么情况下必须拒绝」的断言，而不是「顺利路径能不能跑通」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSetupPlan, parseSetupArgs, normalizeWorkDir } from '../../scripts/setup.js';

const HOME = '/home/tester';
const args = (overrides = {}) => ({ unknown: [], ...overrides });

// ---- 参数解析 ----

test('未知参数不静默忽略', () => {
  // `--work-dirs=/x`（多写一个 s）被当成没写的话，向导会转而问「工作区是哪个」
  // 或者更糟——在 --yes 模式下回落到某个默认值。而用户以为自己已经指定了。
  assert.deepEqual(parseSetupArgs(['--work-dirs=/x']).unknown, ['--work-dirs=/x']);
  assert.deepEqual(parseSetupArgs(['--work-dir=/x']).unknown, []);
});

test('--work-dir 可以给多次，按顺序去重', () => {
  const parsed = parseSetupArgs(['--work-dir=/a', '--work-dir=/b', '--work-dir=/a']);
  assert.deepEqual(parsed.workDirs, ['/a', '/b']);
});

// ---- 工作区归一 ----

test('相对路径被拒——工作区是权限边界，不能取决于从哪个目录启动', () => {
  assert.equal(normalizeWorkDir('./relative', { home: HOME }).code, 'work_dir_not_absolute');
  assert.equal(normalizeWorkDir('~/projects', { home: HOME }).workDir, `${HOME}/projects`, '~ 要展开');
});

test('家目录本身被拒', () => {
  // 把家目录当工作区 = 把 ~/.ssh、~/.aws、其他项目的 .env 一并交给 agent。
  // 这与「不配工作区时拒绝启动」是同一条红线的两个入口——只堵一边等于没堵。
  assert.equal(normalizeWorkDir(HOME, { home: HOME }).code, 'work_dir_is_home');
  assert.equal(normalizeWorkDir(`${HOME}/`, { home: HOME }).code, 'work_dir_is_home', '尾随斜杠不该绕过');
  assert.equal(normalizeWorkDir(`${HOME}/projects`, { home: HOME }).ok, true);
});

// ---- 非交互模式的拒绝矩阵 ----

test('没有 TTY 又没给 --yes → 拒绝，不悄悄走交互分支', () => {
  // 在 CI 或管道里跑时，交互分支会读到 EOF 然后按「默认值」走完——而那些默认值
  // 从来没有人确认过。
  const plan = resolveSetupPlan({ args: args(), isTty: false, home: HOME });
  assert.equal(plan.refuse.code, 'tty_required');
});

test('--yes 但没给 --work-dir → 拒绝，**绝不回落家目录**', () => {
  const plan = resolveSetupPlan({ args: args({ yes: true }), home: HOME });
  assert.equal(plan.refuse.code, 'work_dir_required');
});

test('--yes 且工作区非法 → 按具体原因拒绝，不笼统报错', () => {
  const home = resolveSetupPlan({ args: args({ yes: true, workDirs: [HOME] }), home: HOME });
  assert.equal(home.refuse.code, 'work_dir_is_home');
  const rel = resolveSetupPlan({ args: args({ yes: true, workDirs: ['rel'] }), home: HOME });
  assert.equal(rel.refuse.code, 'work_dir_not_absolute');
});

test('已有配置且没给 --force → 拒绝，并且理由指向 migrate 而不是 --force', () => {
  // --force 会生成一个新 AUTH_TOKEN，所有已注册设备都要重新批准。想保留旧配置
  // 应该走 migrate，而不是覆盖重来——这两条路的代价差得很远。
  const plan = resolveSetupPlan({
    args: args({ yes: true, workDirs: ['/w'] }), configExists: true, home: HOME,
  });
  assert.equal(plan.refuse.code, 'config_exists');
  assert.match(plan.refuse.detail, /migrate/);
});

test('--force 放行覆盖', () => {
  const plan = resolveSetupPlan({
    args: args({ yes: true, force: true, workDirs: ['/w'] }), configExists: true, home: HOME,
  });
  assert.equal(plan.refuse, undefined);
  assert.equal(plan.mode, 'noninteractive');
});

test('非法 HOST 直接拒，不猜意图', () => {
  // 「lan」大概率想要 0.0.0.0，但替用户猜着写进配置，就是向导最不该做的那种
  // 静默决定——而它会一直生效到有人发现为止。
  const plan = resolveSetupPlan({
    args: args({ yes: true, workDirs: ['/w'], host: 'lan' }), home: HOME,
  });
  assert.equal(plan.refuse.code, 'invalid_host');
});

test('未知参数优先于其他一切被拒——它可能正是「我以为我指定了」的那个', () => {
  const plan = resolveSetupPlan({
    args: args({ yes: true, unknown: ['--wrokdir=/x'] }), home: HOME,
  });
  assert.equal(plan.refuse.code, 'unknown_flag');
});

// ---- 非交互的默认值 ----

test('非交互模式下 HOST 缺省是 127.0.0.1——对外监听必须是显式选择', () => {
  // 默认对外监听意味着「跑一遍装机命令」就把服务暴露到局域网。
  // 危险动作的缺省值必须是保守的那一侧。
  const plan = resolveSetupPlan({ args: args({ yes: true, workDirs: ['/w'] }), home: HOME });
  assert.equal(plan.host, '127.0.0.1');
  assert.deepEqual(plan.workDirs, ['/w']);
});

test('交互模式不预先决定任何值——那些由问答填', () => {
  const plan = resolveSetupPlan({ args: args(), isTty: true, home: HOME });
  assert.equal(plan.mode, 'interactive');
  assert.equal(plan.refuse, undefined);
});
