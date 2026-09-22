#!/usr/bin/env node
// scripts/live-walkthrough-mcp.mjs —— 隔离真机：注入一个起不来的 MCP，验告警进流、过程态静默。
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = process.env.CCM_LIVE_PORT || '3240';
const URL = process.env.CCM_LIVE_URL || `http://127.0.0.1:${PORT}`;
const OUT = process.env.CCM_LIVE_OUT || '/tmp/ccm-walkthrough-mcp';
const TURN_MS = 120_000;
const BROKEN = 'walkthrough_broken';

mkdirSync(OUT, { recursive: true });

const realCodex = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
const wrapper = join(tmpdir(), `ccm-codex-broken-mcp-${process.pid}.sh`);
writeFileSync(wrapper, `#!/bin/bash
set -euo pipefail
cmd="$1"
shift
exec ${JSON.stringify(realCodex)} "$cmd" \\
  -c 'mcp_servers.${BROKEN}.command="/nonexistent/ccm-broken-mcp"' \\
  -c 'mcp_servers.${BROKEN}.startup_timeout_sec=5' \\
  "$@"
`);
chmodSync(wrapper, 0o755);

function startServer() {
  const child = spawn(process.execPath, [join(HERE, 'live-walkthrough-server.js')], {
    cwd: ROOT,
    env: { ...process.env, CCM_LIVE_PORT: PORT, CCM_LIVE_CODEX_BIN: wrapper },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.stdout.write(`[live-server] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[live-server-err] ${d}`));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('live server start timeout')), 20_000);
    child.stdout.on('data', d => {
      if (String(d).includes('运行在')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`live server exited ${code}`));
    });
  });
  return { child, ready };
}

async function waitIdle(page) {
  await page.waitForFunction(
    () => {
      const state = globalThis.document.querySelector('#state-label')?.textContent?.trim().toLowerCase();
      const mode = globalThis.document.querySelector('#send-btn')?.getAttribute('data-mode');
      return state === 'idle' && mode !== 'stop';
    },
    null,
    { timeout: TURN_MS },
  );
}

async function inspect(page) {
  return page.evaluate(() => {
    const doc = globalThis.document;
    const system = [...doc.querySelectorAll('.msg.system-msg')].map(el => el.innerText.trim());
    const errors = [...doc.querySelectorAll('.msg.error-msg')].map(el => el.innerText.trim());
    return {
      system,
      errors,
      mcpProgress: system.filter(s => /MCP .+: (starting|ready|updated)/i.test(s) && !/error|fail|crash/i.test(s)),
      mcpAlerts: [...system, ...errors].filter(s => /MCP /i.test(s)),
      nativeTitle: doc.querySelector('#native-panel .native-panel-title, #native-panel h3, #native-panel')?.innerText?.slice(0, 400) || '',
      nativeText: doc.querySelector('#native-panel')?.innerText?.slice(0, 800) || '',
      assistant: [...doc.querySelectorAll('.msg.codex .bubble')].map(el => el.innerText.trim().slice(0, 200)),
    };
  });
}

const findings = [];
function note(level, title, detail) {
  findings.push({ level, title, detail: detail || '' });
  console.log(`[${level}] ${title}${detail ? ` — ${detail}` : ''}`);
}

const { child, ready } = startServer();
let browser;
try {
  await ready;
  browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 5'] });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const s = globalThis.document.querySelector('#state-label')?.textContent?.trim().toLowerCase();
      return s && s !== 'offline';
    },
    null,
    { timeout: 20_000 },
  );
  await waitIdle(page);
  await page.screenshot({ path: join(OUT, '01-first-paint.png') });

  const alert = page.locator('.msg.error-msg, .msg.system-msg').filter({ hasText: /MCP /i });
  const sawAlert = await alert.first().waitFor({ state: 'visible', timeout: 45_000 }).then(() => true).catch(() => false);
  await page.screenshot({ path: join(OUT, '02-mcp-stream.png'), fullPage: true });
  const afterStart = await inspect(page);
  console.log('[live] mcpAlerts', afterStart.mcpAlerts.join(' | ') || '(none)');
  console.log('[live] mcpProgress', afterStart.mcpProgress.join(' | ') || '(none)');
  console.log('[live] errors', afterStart.errors.join(' | ') || '(none)');

  if (!sawAlert && !afterStart.mcpAlerts.length && !afterStart.errors.some(s => /MCP /i.test(s))) {
    note('P0', 'MCP 起不来时消息流没有告警');
  } else {
    const text = (afterStart.mcpAlerts.join('\n') + '\n' + afterStart.errors.join('\n'));
    if (!new RegExp(BROKEN, 'i').test(text) && !/MCP /i.test(text)) {
      note('P0', '告警里没有 MCP 字样', text.slice(0, 240));
    } else {
      note('ok', 'MCP 失败进了消息流', afterStart.mcpAlerts.concat(afterStart.errors).filter(s => /MCP /i.test(s)).join(' | '));
    }
  }
  if (afterStart.mcpProgress.length) {
    note('P0', 'MCP 过程态进了消息流', afterStart.mcpProgress.join(' | '));
  } else {
    note('ok', 'MCP 过程态保持静默');
  }

  await page.locator('#menu-btn').click();
  await page.locator('#drawer').waitFor({ state: 'visible', timeout: 8_000 });
  const settings = page.locator('#btn-general-settings');
  if (await settings.count()) {
    await settings.click();
    await page.locator('#settings-sheet').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  }
  const mcpBtn = page.locator('#native-mcp-btn');
  if (await mcpBtn.count()) {
    await mcpBtn.click();
    await page.locator('#native-panel').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
  await page.screenshot({ path: join(OUT, '03-mcp-panel.png'), fullPage: true });
  const panel = await inspect(page);
  if (!/MCP|walkthrough|broken|node_repl/i.test(panel.nativeText + panel.nativeTitle)) {
    note('P1', 'MCP 面板没有列出服务器', panel.nativeText.slice(0, 200));
  } else {
    note('ok', 'MCP 面板有内容', panel.nativeText.replace(/\s+/g, ' ').slice(0, 200));
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.locator('#drawer-close').click().catch(() => {});
  await waitIdle(page);
  await page.locator('#msg-input').fill('你是谁？一句话，不要调用工具。');
  await page.locator('#send-btn').click();
  await page.locator('.msg.user').last().waitFor({ timeout: 10_000 });
  await page.waitForFunction(
    () => globalThis.document.querySelector('#state-label')?.textContent?.trim().toLowerCase() === 'idle'
      && globalThis.document.querySelector('#send-btn')?.getAttribute('data-mode') !== 'stop',
    null,
    { timeout: TURN_MS },
  );
  await page.screenshot({ path: join(OUT, '04-after-turn.png'), fullPage: true });
  const afterTurn = await inspect(page);
  if (!afterTurn.assistant.length) note('P0', 'MCP 失败后对话没有助手回复');
  else note('ok', 'MCP 失败后对话仍能回答', afterTurn.assistant.at(-1));

  writeFileSync(join(OUT, 'findings.json'), `${JSON.stringify({ afterStart, panel, afterTurn, findings }, null, 2)}\n`);
  const p0 = findings.filter(f => f.level === 'P0');
  console.log(`[live] screenshots ${OUT}`);
  console.log(`[live] P0=${p0.length} total=${findings.length}`);
  if (p0.length) process.exitCode = 2;
} catch (err) {
  console.error('[live] FAIL', err);
  try {
    writeFileSync(join(OUT, 'findings.json'), `${JSON.stringify({ findings, error: String(err) }, null, 2)}\n`);
  } catch { /* noop */ }
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* noop */ }
  try { child.kill('SIGTERM'); } catch { /* noop */ }
}
