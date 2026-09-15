// test/invariants/thread-source-of-truth.test.mjs —— thread 的真相源只有 app-server 一处。
// 守护：A2
//
// 与 zero-persistence-guard 的分工：那边扫「有没有往 DATA_DIR 写新东西」，这边扫
// 「有没有把已经退役的第二份真相读回来」—— sessions.json、Codex JSONL 历史、
// 以及 session:list/select/history 这类 legacy 别名。两个方向都堵上，A2 才是闭合的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const server = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const scenarioServer = readFileSync(new URL('../../scripts/scenario-server.js', import.meta.url), 'utf8');
const appServerSession = readFileSync(new URL('../../src/agent/agent-appserver.js', import.meta.url), 'utf8');
const uploads = readFileSync(new URL('../../src/files/uploads.js', import.meta.url), 'utf8');

test('production server no longer reads or writes sessions.json or Codex JSONL history', () => {
  assert.doesNotMatch(server, /from '\.\/sessions\.js'/);
  assert.doesNotMatch(server, /from '\.\/history\.js'/);
  assert.doesNotMatch(server, /\bsessions\./);
  assert.doesNotMatch(server, /listCodexSessions|getSessionHistory|codexSessions/);
  assert.match(server, /\.listThreads\(/);
  assert.match(server, /\.readThread\(/);
});

test('production package does not ship duplicate legacy session, history, or push modules', () => {
  for (const file of ['sessions.js', 'history.js', 'push.js']) {
    assert.equal(
      existsSync(new URL(`../../${file}`, import.meta.url)),
      false,
      `${file} must be removed after app-server threads and the authenticated gateway became authoritative`,
    );
  }
});

test('browser gateway exposes thread APIs without legacy session list, select, or history aliases', () => {
  for (const event of ['thread:list', 'thread:select', 'thread:history']) {
    assert.match(server, new RegExp(`on\\(socket, '${event.replace(':', '\\:')}'`));
  }
  for (const event of ['session:list', 'session:select', 'session:history', 'session_list']) {
    assert.doesNotMatch(server, new RegExp(event.replace(':', '\\:')));
  }
});

test('browser scenario server mirrors the authoritative thread API surface', () => {
  for (const event of ['thread:list', 'thread:select', 'thread:history']) {
    assert.match(scenarioServer, new RegExp(`socket\\.on\\('${event.replace(':', '\\:')}'`));
  }
  for (const event of ['session:list', 'session:select', 'session:history', 'session_list']) {
    assert.doesNotMatch(scenarioServer, new RegExp(event.replace(':', '\\:')));
  }
});

test('production input pipeline uses structured user inputs without legacy prompt concatenation', () => {
  assert.match(appServerSession, /input: buildUserInputs\(/);
  assert.doesNotMatch(appServerSession, /buildPromptText|\[附件\]/);
  assert.doesNotMatch(uploads, /buildPromptText|\[附件\]/);
});

test('browser view routing has no process-global viewing instance fallback', () => {
  assert.doesNotMatch(server, /\blet viewingInstanceId\b/);
  assert.doesNotMatch(server, /routeInstance\(viewingInstanceId\)/);
  assert.match(server, /routeInstance\(socket\.data\.viewingInstanceId\)/);
});
