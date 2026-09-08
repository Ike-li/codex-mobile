// scripts/doctor.js —— 启动前自检脚本
// 检查：CODEX_BIN/codex in PATH、WORK_DIR、data/ 可写、AUTH_TOKEN、状态库 schema
import { statSync, accessSync, mkdirSync, constants, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
// 与运行时兜底认同一个形态。~/.codex 是全局共享的，桌面版 Codex 一升级就把新迁移
// 写进去，pin 住旧版的本项目再去读自己那版才有的表就扑空。
import { SCHEMA_MISMATCH } from '../public/js/thread-actions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * 判断一段 codex 错误是不是状态库 schema 不兼容，并给出下一步。
 *
 * @param {string} raw codex / app-server 吐出的错误文本
 * @returns {{compatible: boolean, hint?: string}}
 */
export function schemaVerdict(raw) {
  if (!raw || !SCHEMA_MISMATCH.test(raw)) return { compatible: true };

  let pin = '';
  try { pin = readFileSync(join(ROOT, '.codex-version'), 'utf8').trim(); } catch { /* 没有 pin 文件 */ }

  // 只给最可能奏效的那一个动作。成因也可能是库损坏或 CODEX_HOME 指错，所以措辞是
  // 「多半」而不是断言——但不给「稍后再试」那种假出路，重试对这个故障没有任何作用。
  return {
    compatible: false,
    hint: `状态库里缺表或缺列，多半是跑着的 codex 比 ~/.codex 里的库旧。\n`
      + `     ~/.codex 是全局共享的，桌面版 Codex 升级会单向写入新迁移。\n`
      + `     下一步：把 codex 对齐到 .codex-version（${pin || '见该文件'}），`
      + `或确认 CODEX_HOME 指向的是同一个目录。`,
  };
}

/**
 * 用一次只读调用探测状态库能不能读。
 *
 * 判据是「这条链路现在能不能用」，不是「库里有哪些表」——本项目不直接读 sqlite
 * （~/.codex 下有六个带版本后缀的库），状态库由 codex 进程独占，我们只能通过
 * app-server 观察。
 *
 * @param {{request: (method: string, params?: object) => Promise<unknown>}} deps
 *   request 是外部边界（codex 子进程），注入以便测试。
 */
export async function probeSchema({ request }) {
  try {
    // 只读、零额度。发 turn 那类会真的调用模型，与「日常回归不消耗额度」冲突。
    await request('thread/list', { pageSize: 1 });
    return { compatible: true };
  } catch (err) {
    const raw = String(err?.message || err);
    const verdict = schemaVerdict(raw);
    if (!verdict.compatible) return verdict;
    // 不是 schema 问题，但探测确实没成功。静默当成通过等于这道检查不存在。
    return { compatible: true, probeError: raw };
  }
}

// ---- CLI ----
// import 本模块时不执行自检（测试要 import 上面的纯函数）。

async function main() {
  try {
    const { config } = await import('dotenv');
    config({ path: join(ROOT, '.env') });
  } catch { /* dotenv not installed yet or no .env */ }

  let passed = 0;
  let failed = 0;

  function check(label, fn) {
    try {
      const result = fn();
      console.log(`  ✅ ${label}${result ? ': ' + result : ''}`);
      passed++;
    } catch (err) {
      console.log(`  ❌ ${label}: ${err.message}`);
      failed++;
    }
  }

  async function checkAsync(label, fn) {
    try {
      const result = await fn();
      console.log(`  ✅ ${label}${result ? ': ' + result : ''}`);
      passed++;
    } catch (err) {
      console.log(`  ❌ ${label}: ${err.message}`);
      failed++;
    }
  }

  console.log('\nCodex Chat Mobile — 启动自检\n');

  // D1: codex binary
  check('CODEX_BIN / codex in PATH', () => {
    const bin = process.env.CODEX_BIN || '';
    if (bin) {
      statSync(bin);
      return bin;
    }
    const found = execSync('which codex', { encoding: 'utf8' }).trim();
    if (!found) throw new Error('未找到 codex 命令');
    return found;
  });

  // D2: WORK_DIR
  check('WORK_DIR 是有效目录', () => {
    const dir = process.env.WORK_DIR;
    if (!dir) throw new Error('WORK_DIR 未设置');
    if (!statSync(dir).isDirectory()) throw new Error(`不是目录: ${dir}`);
    return dir;
  });

  // D3: data/ writable
  check('data/ 目录可写', () => {
    const dataDir = process.env.CODEX_DATA_DIR || join(ROOT, 'data');
    mkdirSync(dataDir, { recursive: true });
    accessSync(dataDir, constants.W_OK);
    return dataDir;
  });

  // D4: AUTH_TOKEN
  check('AUTH_TOKEN 已设置', () => {
    if (!process.env.AUTH_TOKEN) throw new Error('AUTH_TOKEN 未设置（公网访问时需要）');
    return `${process.env.AUTH_TOKEN.slice(0, 4)}****`;
  });

  // D5: 绑定到非 loopback 时的 token 强度。server-security 会在启动时 fail-closed，
  // 这里提前说清楚，免得部署到服务器上才发现起不来。
  check('远程绑定的 token 强度', () => {
    const host = process.env.HOST || '127.0.0.1';
    const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    if (loopback) return `HOST=${host}（仅本机，无额外要求）`;
    const token = process.env.AUTH_TOKEN || '';
    if (token.length < 32) throw new Error(`HOST=${host} 需要 AUTH_TOKEN ≥32 字符，当前 ${token.length}`);
    return `HOST=${host}，token ${token.length} 字符`;
  });

  // D6: 无图形界面。这是本项目相对官方 Remote 的差异点——官方要求 host 跑 ChatGPT 桌面 app
  // （仅 macOS/Windows）。缺 DISPLAY 是服务器的常态，不该影响任何东西，明确报出来让人放心。
  check('无图形界面也能运行', () => {
    const headless = !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    return headless ? '未检测到 DISPLAY/WAYLAND_DISPLAY，无需图形界面' : '当前有图形会话（无头环境同样支持）';
  });

  // D7: 状态库 schema。运行时撞上这个故障的症状是点开会话列表才报一句 no such table，
  // 而那时用户多半在手机上、离机器很远。这里提前问一次，用一次只读调用，零额度。
  await checkAsync('状态库 schema 可读', async () => {
    const { AppServerTransport } = await import('../app-server-transport.js');
    const transport = new AppServerTransport({
      codexBin: process.env.CODEX_BIN || 'codex',
      cwd: process.env.WORK_DIR || ROOT,
    });
    const timeoutMs = 20000;
    try {
      transport.start();
      try {
        await transport.request('initialize', {
          clientInfo: { name: 'codex-chat-mobile-doctor', title: 'Doctor', version: '0.1.0' },
          capabilities: { experimentalApi: false, requestAttestation: false },
        }, { timeoutMs });
        transport.notify('initialized', {});
      } catch (err) {
        // 握手本身也可能撞上缺表——那时同样该给对齐版本的提示，而不是一句握手失败。
        const verdict = schemaVerdict(String(err?.message || err));
        if (!verdict.compatible) throw new Error(verdict.hint);
        throw new Error(`app-server 握手失败：${err.message}`);
      }

      const verdict = await probeSchema({
        request: (method, params) => transport.request(method, params, { timeoutMs }),
      });
      if (!verdict.compatible) throw new Error(verdict.hint);
      if (verdict.probeError) throw new Error(`探测未完成：${verdict.probeError}`);
      return '通过 thread/list 只读探测，未发现缺表/缺列';
    } finally {
      transport.dispose();
    }
  });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  if (failed > 0) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('doctor.js')) await main();
