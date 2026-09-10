// scripts/smoke-appserver.js —— 用真实 codex app-server 驱动 ThreadRuntime 一次。
// 验证：JSON-RPC 握手 + thread/start + turn/start + 流式 delta + turn/completed。
// 用法：node scripts/smoke-appserver.js [cwd]   （需 codex 已登录；会消耗少量额度）
import { ThreadRuntime } from '../agent-appserver.js';

const cwd = process.argv[2] || process.cwd();
const events = [];
let settle;
const done = new Promise(r => { settle = r; });

const session = new ThreadRuntime({
  instanceId: 'smoke',
  cwd,
  codexBin: process.env.CODEX_BIN || 'codex',
  idleTimeoutMs: 120000,
  onEvent: env => {
    events.push(env);
    console.log(`[evt] ${env.type} ${JSON.stringify(env.payload ?? {}).slice(0, 140)}`);
    if (env.type === 'result') settle('result');
    if (env.type === 'error') settle('error');
  },
  onSessionId: sid => console.log('[sessionId]', sid),
  onExit: () => {},
});

const t = setTimeout(() => settle('timeout'), 90000);
session.send('Reply with just the word PONG.');

const reason = await done;
clearTimeout(t);
session.dispose();

const text = events.filter(e => e.type === 'text_delta').map(e => e.payload.text).join('');
const hasInit = events.some(e => e.type === 'init');
console.log('\n=== APP-SERVER SMOKE ===');
console.log(`reason:${reason} | init:${hasInit} | text:${JSON.stringify(text)}`);
const pass = reason === 'result' && hasInit && text.trim();
console.log(pass ? '✅ PASS（握手+流式+完成）' : '❌ FAIL');
process.exit(pass ? 0 : 1);
