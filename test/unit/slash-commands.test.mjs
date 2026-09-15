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
} from '../../public/js/slash-commands.js';

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

test('/plan 和 /chat 仍然走模式分支，并保留后续文本', () => {
  assert.deepEqual(resolveSlashCommand('/plan'), { kind: 'mode', cmd: '/plan', mode: 'plan', rest: '' });
  assert.deepEqual(resolveSlashCommand('/plan 先列步骤'), { kind: 'mode', cmd: '/plan', mode: 'plan', rest: '先列步骤' });
  assert.deepEqual(resolveSlashCommand('/chat'), { kind: 'mode', cmd: '/chat', mode: 'default', rest: '' });
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
test('slash popup 里的每个条目都必须真的接上动作', () => {
  const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');
  const popup = html.slice(html.indexOf('id="slash-popup"'));
  const block = popup.slice(0, popup.indexOf('</div>\n\n'));
  const cmds = [...block.matchAll(/data-cmd="([^"]+)"/g)].map(m => m[1]);

  assert.ok(cmds.length > 0, '没解析到 popup 条目，选择器过时了');
  for (const cmd of cmds) {
    const resolved = resolveSlashCommand(cmd);
    assert.ok(resolved, `${cmd} 在 popup 里但解析不出来`);
    assert.ok(
      resolved.kind === 'action' || resolved.kind === 'mode',
      `${cmd} 在 popup 里但是 ${resolved.kind}——UI 不能列出执行不了的命令`,
    );
  }
});

test('/help 列出的就是分发表本身，不会和实现漂移', () => {
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
