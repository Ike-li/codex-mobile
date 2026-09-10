// scripts/smoke-server.js —— 全栈端到端：启动 server.js + socket.io-client 跑一轮。
// 验证 server.js 的 Socket.IO 契约、ThreadRuntime 协同。
// 用法：node scripts/smoke-server.js   （需 codex 已登录；会消耗少量额度）
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const PORT = 3199;
const server = spawn('node', ['server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), WORK_DIR: '/tmp/codex-ccm-sample', AUTH_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function cleanup(code) { try { server.kill('SIGTERM'); } catch { /* noop */ } process.exit(code); }
const hardTimeout = setTimeout(() => { console.error('❌ TIMEOUT'); cleanup(1); }, 100000);

let ready;
const readyP = new Promise(r => { ready = r; });
server.stdout.on('data', d => { process.stdout.write(`[server] ${d}`); if (d.toString().includes('运行在')) ready(); });
server.stderr.on('data', d => process.stderr.write(`[server-err] ${d}`));

await Promise.race([
  readyP,
  new Promise((_, rej) => setTimeout(() => rej(new Error('server start timeout')), 15000)),
]).catch(e => { console.error(e.message); cleanup(1); });

const socket = io(`http://localhost:${PORT}`, { transports: ['websocket'] });
const events = [];
socket.on('connect', () => { console.log('[client] connected'); socket.emit('user:message', { text: 'Reply with just the word PONG.' }); });
socket.on('connect_error', e => { console.error('connect_error', e.message); cleanup(1); });
socket.on('agent:event', ev => {
  events.push(ev);
  if (['init', 'text_delta', 'result', 'error'].includes(ev.type)) console.log(`[evt] ${ev.type} ${JSON.stringify(ev.payload ?? {}).slice(0, 100)}`);
  if (ev.type === 'result') {
    clearTimeout(hardTimeout);
    const text = events.filter(e => e.type === 'text_delta').map(e => e.payload.text).join('');
    console.log('\n=== SERVER E2E ===');
    console.log('text:', JSON.stringify(text));
    console.log(text.trim() ? '✅ PASS（全栈打通）' : '❌ FAIL');
    cleanup(text.trim() ? 0 : 1);
  }
});
