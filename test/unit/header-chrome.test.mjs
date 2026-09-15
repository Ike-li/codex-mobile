import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRttChip,
  formatWorkspaceChangeBadge,
} from '../../public/js/header-chrome.js';

test('RTT chip hides invalid samples and labels milliseconds or seconds', () => {
  assert.deepEqual(formatRttChip(NaN), { visible: false, label: '', tone: '' });
  assert.deepEqual(formatRttChip(-1), { visible: false, label: '', tone: '' });
  assert.deepEqual(formatRttChip(42), { visible: true, label: '延迟 42ms', tone: 'good' });
  assert.deepEqual(formatRttChip(450), { visible: true, label: '延迟 450ms', tone: 'warn' });
  assert.deepEqual(formatRttChip(1500), { visible: true, label: '延迟 1.5s', tone: 'bad' });
});

test('workspace change badge only appears for a dirty git workspace', () => {
  assert.equal(formatWorkspaceChangeBadge(null), '');
  assert.equal(formatWorkspaceChangeBadge({}), '');
  assert.equal(formatWorkspaceChangeBadge({ branch: 'main', changed: 0 }), '');
  assert.equal(formatWorkspaceChangeBadge({ branch: 'main', changed: 5 }), '5');
  assert.equal(formatWorkspaceChangeBadge({ branch: 'main', changed: 140 }), '99+');
});
