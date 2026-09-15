import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupThreadsByProject, projectLabel } from '../../public/js/project-label.js';

test('projectLabel uses the last path segment as the project name', () => {
  assert.equal(projectLabel('/Users/raylee/code/codex-chat-mobile'), 'codex-chat-mobile');
  assert.equal(projectLabel('/tmp/mock-workdir/'), 'mock-workdir');
  assert.equal(projectLabel('resume'), 'resume');
  assert.equal(projectLabel(''), '');
});

test('groupThreadsByProject keeps conversations under their cwd project', () => {
  const groups = groupThreadsByProject([
    { id: 't1', title: 'Review resume', cwd: '/Users/raylee/code/resume' },
    { id: 't2', title: 'Add lyrics', cwd: '/Users/raylee/code/codex-chat-mobile' },
    { id: 't3', title: 'Fix drawer', cwd: '/Users/raylee/code/codex-chat-mobile' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].project, 'resume');
  assert.deepEqual(groups[0].threads.map(thread => thread.id), ['t1']);
  assert.equal(groups[1].project, 'codex-chat-mobile');
  assert.deepEqual(groups[1].threads.map(thread => thread.id), ['t2', 't3']);
});
