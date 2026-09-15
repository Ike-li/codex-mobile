import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandCard, fileChangeCard } from '../../public/js/render/tool-cards.js';

test('a running command card exposes a foldable command and no exit yet', () => {
  const card = commandCard({ command: 'ls -la', running: true });
  assert.equal(card.title, '命令');
  assert.equal(card.command, 'ls -la');
  assert.equal(card.running, true);
  assert.equal(card.ok, null);
  assert.equal(card.exitCode, null);
});

test('a finished command card records exit code and success color', () => {
  const card = commandCard({
    command: 'node missing-script.js',
    output: 'done',
    exitCode: 0,
    status: 'completed',
  });
  assert.equal(card.title, '命令');
  assert.equal(card.exitCode, 0);
  assert.equal(card.ok, true);
  assert.equal(card.running, false);
});

test('a failed command card is marked unsuccessful', () => {
  const card = commandCard({ command: 'false', exitCode: 1 });
  assert.equal(card.ok, false);
  assert.equal(card.exitCode, 1);
});

test('a file change card keeps path, kind, and expandable diff', () => {
  const card = fileChangeCard({
    files: [
      { path: 'src/a.js', kind: 'add', diff: '+export const a = 1\n' },
      { path: 'src/b.js', kind: 'modify' },
    ],
  });
  assert.equal(card.title, '文件变更');
  assert.equal(card.files.length, 2);
  assert.equal(card.files[0].path, 'src/a.js');
  assert.equal(card.files[0].kind, 'add');
  assert.equal(card.files[0].kindLabel, '新增');
  assert.equal(card.files[0].expandable, true);
  assert.equal(card.files[1].path, 'src/b.js');
  assert.equal(card.files[1].kindLabel, '修改');
  assert.equal(card.files[1].expandable, false);
});
