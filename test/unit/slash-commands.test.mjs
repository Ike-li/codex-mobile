// test/unit/slash-commands.test.mjs —— 斜杠命令的解析与分发表。
// 红线：只测「文本 → 意图」的映射。真正的副作用（开面板、发 socket）在 app.js 里绑定，
// 那层由 e2e 覆盖；这里锁住的是解析规则和「UI 承诺的命令必须真的接上」这条契约。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSlashCommand,
  SLASH_ACTIONS,
  UNSUPPORTED_SLASH,
  slashHelpLines,
  slashPickerItems,
} from '../../public/js/compose/slash-commands.js';

test('已接入的命令解析成 action，动作 id 来自分发表', () => {
  assert.deepEqual(resolveSlashCommand('/compact'), { kind: 'action', cmd: '/compact', action: 'compact', args: '' });
  assert.deepEqual(resolveSlashCommand('/diff'), { kind: 'action', cmd: '/diff', action: 'diff', args: '' });
  assert.deepEqual(resolveSlashCommand('/mcp'), { kind: 'action', cmd: '/mcp', action: 'mcp', args: '' });
});

test('命令名大小写不敏感，尾随空格不影响解析', () => {
  assert.deepEqual(resolveSlashCommand('/Compact'), { kind: 'action', cmd: '/compact', action: 'compact', args: '' });
  assert.deepEqual(resolveSlashCommand('  /COMPACT  '), { kind: 'action', cmd: '/compact', action: 'compact', args: '' });
});

test('/review 收参数：无参数审当前改动，有参数当自定义审查指令', () => {
  assert.deepEqual(resolveSlashCommand('/review'), { kind: 'action', cmd: '/review', action: 'review', args: '' });
  assert.deepEqual(
    resolveSlashCommand('/review 重点看并发安全'),
    { kind: 'action', cmd: '/review', action: 'review', args: '重点看并发安全' },
  );
  // 参数原样保留：审查指令里的大小写和标点都是给模型看的。
  assert.deepEqual(
    resolveSlashCommand('/review Check the SQL escaping'),
    { kind: 'action', cmd: '/review', action: 'review', args: 'Check the SQL escaping' },
  );
});

test('不收参数的命令带了参数就不是命令意图，照旧当普通消息', () => {
  assert.equal(resolveSlashCommand('/compact 顺便说一句'), null);
  assert.equal(resolveSlashCommand('/diff src/foo.js'), null);
});

test('/chat 仍然走模式分支，并保留后续文本', () => {
  assert.deepEqual(resolveSlashCommand('/chat'), { kind: 'mode', cmd: '/chat', mode: 'default', rest: '' });
  assert.deepEqual(resolveSlashCommand('/chat 继续'), { kind: 'mode', cmd: '/chat', mode: 'default', rest: '继续' });
});

test('/plan 在协议接通前是 unsupported，不进挑选层', () => {
  const plan = resolveSlashCommand('/plan');
  assert.equal(plan.kind, 'unsupported');
  assert.equal(plan.cmd, '/plan');
  assert.match(plan.reason, /计划模式/);
  assert.ok(!slashPickerItems().some(item => item.cmd === '/plan'));
});

test('codex 有、移动端接不了的命令报 unsupported 并给出原因', () => {
  const init = resolveSlashCommand('/init');
  assert.equal(init.kind, 'unsupported');
  assert.equal(init.cmd, '/init');
  assert.ok(init.reason, '必须带原因，否则用户不知道该改用什么');

  const vim = resolveSlashCommand('/vim');
  assert.equal(vim.kind, 'unsupported');
  assert.ok(vim.reason);
});

test('不认识的命令报 unknown，不静默当成消息发出去', () => {
  assert.deepEqual(resolveSlashCommand('/nope'), { kind: 'unknown', cmd: '/nope' });
  assert.deepEqual(resolveSlashCommand('/zzz-123'), { kind: 'unknown', cmd: '/zzz-123' });
});

test('绝对路径不是命令意图——误判会把正常消息拦下来', () => {
  assert.equal(resolveSlashCommand('/usr/bin/codex'), null);
  assert.equal(resolveSlashCommand('/etc/hosts'), null);
  assert.equal(resolveSlashCommand('/Users/me/code'), null);
});

test('带空格的整句当普通文本，只有孤零零一个命令词才是命令意图', () => {
  assert.equal(resolveSlashCommand('/help me fix this'), null);
  assert.equal(resolveSlashCommand('/nope 这句话是给模型看的'), null);
});

test('非命令输入返回 null', () => {
  assert.equal(resolveSlashCommand(''), null);
  assert.equal(resolveSlashCommand('compact'), null);
  assert.equal(resolveSlashCommand('看看 /compact 是什么'), null);
  assert.equal(resolveSlashCommand(null), null);
  assert.equal(resolveSlashCommand(undefined), null);
  assert.equal(resolveSlashCommand('/'), null);
});

// 这条是这次改动的核心契约：popup 曾经列出 /status /diff /compact 等条目，
// 点了却只是把文本塞进输入框当消息发。UI 承诺过的命令必须真的能执行，
// 否则用户以为自己压缩了上下文，其实是往对话里塞了句 "/compact"。
test('slash picker 的每个条目都必须真的接上动作', () => {
  const items = slashPickerItems();
  assert.ok(items.length > 0, '挑选层不能是空表');
  for (const { cmd } of items) {
    const resolved = resolveSlashCommand(cmd);
    assert.equal(resolved?.kind, 'action', `${cmd} 在挑选层但是 ${resolved?.kind}——不能列出执行不了的命令`);
  }
});

// codex 的 `/` 命令表是 TUI 硬编码的，app-server 一个字都不上报（InitializeResponse 只有
// codexHome / platformFamily / platformOs）。所以内置这几条只能写死。
//
// 但真正天天变的不是它们，是用户自己加的 skill —— 那部分 codex 给得很足：skills/list 能拉、
// skills/changed 会推。把 skill 并进同一个挑选层，「上游更新不用管」就在会变的那一半成立了。
test('挑选层把内置命令和动态 skill 并成两段', () => {
  const skills = [
    { name: 'archify', description: '画架构图', path: '/s/archify/SKILL.md' },
    { name: 'tdd', description: '测试先行', path: '/s/tdd/SKILL.md' },
  ];
  const items = slashPickerItems({ skills });

  const builtins = items.filter(item => item.kind === 'builtin');
  const skillItems = items.filter(item => item.kind === 'skill');
  assert.ok(builtins.length > 0, '内置那段不能丢');
  assert.deepEqual(skillItems.map(item => item.cmd), ['/archify', '/tdd']);
  assert.deepEqual(items.slice(0, builtins.length).map(item => item.kind),
    Array(builtins.length).fill('builtin'), '内置在前、skill 在后，两段不交错');

  // skill 条目要带够身份：选中后走 {type:'skill', name, path} 输入，不是往输入框塞文本。
  assert.equal(skillItems[0].name, 'archify');
  assert.equal(skillItems[0].path, '/s/archify/SKILL.md');
  assert.equal(skillItems[0].desc, '画架构图');
});

test('没有 skill 时挑选层退回纯内置，不留空段', () => {
  assert.deepEqual(slashPickerItems({ skills: [] }).map(i => i.kind),
    slashPickerItems().map(i => i.kind));
  assert.ok(slashPickerItems().every(item => item.kind === 'builtin'));
});

// /status 与 /permissions 在 codex 里是三条不同的命令，在这边却都打开同一个「会话设置」
// sheet。列表里摆三个名字指向同一处是噪音，但 CLI 肌肉记忆不该失效——所以隐藏、不删。
test('同义命令在列表里只留一个，但仍然解析得动', () => {
  const listed = slashPickerItems().map(item => item.cmd);
  assert.ok(listed.includes('/model'), '留下的那个要在');
  assert.ok(!listed.includes('/status'), '/status 是别名，不进列表');
  assert.ok(!listed.includes('/permissions'), '/permissions 同理');

  for (const alias of ['/status', '/permissions']) {
    assert.equal(resolveSlashCommand(alias)?.kind, 'action', `${alias} 必须仍然能用`);
  }
});

// /help 的实现是「把输入框设成 / 再弹一次挑选层」——它就是 / 本身。
test('/help 不再存在：它等于 / 自己', () => {
  assert.ok(!('/help' in SLASH_ACTIONS));
  assert.ok(!slashPickerItems().some(item => item.cmd === '/help'));
});

test('index.html 的斜杠挑选层由分发表生成，不写死条目', () => {
  const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');
  const start = html.indexOf('id="slash-popup"');
  assert.ok(start >= 0, '缺少 #slash-popup');
  const block = html.slice(start, html.indexOf('</div>', start) + 6);
  assert.doesNotMatch(block, /data-cmd=/, '挑选层条目必须从 SLASH_ACTIONS 生成，不能在 HTML 里写死');
});

test('帮助文案列出的就是分发表本身，不会和实现漂移', () => {
  const lines = slashHelpLines();
  assert.ok(lines.length >= Object.keys(SLASH_ACTIONS).length);
  for (const cmd of Object.keys(SLASH_ACTIONS)) {
    assert.ok(lines.some(line => line.startsWith(`${cmd} `)), `/help 漏了 ${cmd}`);
  }
});

test('分发表和不支持表没有重叠命令', () => {
  for (const cmd of Object.keys(UNSUPPORTED_SLASH)) {
    assert.ok(!(cmd in SLASH_ACTIONS), `${cmd} 同时出现在两张表里`);
  }
});
