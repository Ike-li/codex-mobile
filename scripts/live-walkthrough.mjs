#!/usr/bin/env node
// scripts/live-walkthrough.mjs —— 当用户走隔离真机实例。会烧额度。不进 test:ci。
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = process.env.CCM_LIVE_PORT || '3240';
const URL = process.env.CCM_LIVE_URL || `http://127.0.0.1:${PORT}`;
const OUT = process.env.CCM_LIVE_OUT || '/tmp/ccm-walkthrough';
const TURN_MS = 120_000;

mkdirSync(OUT, { recursive: true });

function startServer() {
  const child = spawn(process.execPath, [join(HERE, 'live-walkthrough-server.js')], {
    cwd: ROOT,
    env: { ...process.env, CCM_LIVE_PORT: PORT },
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

async function waitTurnStarted(page) {
  await page.waitForFunction(
    () => {
      const state = globalThis.document.querySelector('#state-label')?.textContent?.trim().toLowerCase();
      const mode = globalThis.document.querySelector('#send-btn')?.getAttribute('data-mode');
      const thinking = globalThis.document.querySelector('.reasoning-card, .msg.codex');
      return state === 'running' || mode === 'stop' || Boolean(thinking);
    },
    null,
    { timeout: 20_000 },
  ).catch(() => {});
}

async function inspectTranscript(page) {
  return page.evaluate(() => {
    const doc = globalThis.document;
    const root = doc.querySelector('#messages');
    const text = root?.innerText || '';
    const system = [...doc.querySelectorAll('.msg.system-msg')].map(el => el.innerText.trim());
    const raw = doc.querySelectorAll('[data-activity="raw"], .tool-json').length;
    return {
      system,
      raw,
      hasRawLabel: /Raw:/i.test(text),
      mcpProgress: system.filter(s => /MCP .+: (starting|ready|updated)/i.test(s)),
      threadIds: system.filter(s => /Thread |已归档:|压缩完成:/i.test(s)),
      englishInfra: system.filter(s => /Skills changed|Rate limits updated|Unsupported server request/i.test(s)),
      user: [...doc.querySelectorAll('.msg.user .bubble')].map(el => el.innerText.trim()),
      assistant: [...doc.querySelectorAll('.msg.codex .bubble.md, .msg.codex .bubble')].map(el => el.innerText.trim().slice(0, 240)),
      cards: [...doc.querySelectorAll('.tool-card')].map(el => ({
        card: el.dataset.card || '',
        activity: el.dataset.activity || '',
        label: (el.querySelector('.activity-label, .tool-name')?.textContent || '').trim().slice(0, 80),
      })),
      copyText: doc.querySelector('.turn-action[data-action="copy"]')?.textContent?.trim() || '',
      modelChip: doc.querySelector('#model-trigger-text')?.textContent?.trim() || '',
      modelHidden: Boolean(doc.querySelector('#model-trigger')?.hidden),
      slashHelpInStream: Boolean(doc.querySelector('.msg.system-msg.slash-help')),
      slashPopupOpen: doc.querySelector('#slash-popup')?.classList.contains('show') === true,
      offlineQueue: [...doc.querySelectorAll('.offline-label')].map(el => el.textContent.trim()),
      outcome: (() => {
        const el = [...doc.querySelectorAll('.tool-card[data-card="outcome"]')].at(-1);
        const frame = doc.querySelector('#messages');
        if (!el || !frame) return null;
        const er = el.getBoundingClientRect();
        const fr = frame.getBoundingClientRect();
        return {
          clipped: er.bottom > fr.bottom + 1,
          label: (el.querySelector('.tool-name')?.textContent || '').trim(),
        };
      })(),
    };
  });
}

async function pickCheapModel(page) {
  const trigger = page.locator('[data-testid="composer-defaults"]');
  if (!await trigger.count()) return { picked: null, models: [] };
  await trigger.click();
  await page.locator('#session-settings').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('#model-list [data-model]').first().waitFor({ timeout: 15_000 }).catch(() => {});
  const models = await page.locator('#model-list [data-model]').evaluateAll(
    els => els.map(el => el.getAttribute('data-model') || '').filter(Boolean),
  );
  const cheap = models.find(id => /mini|nano/i.test(id) && !/codex/i.test(id))
    || models.find(id => /mini|nano/i.test(id))
    || models.find(id => /^gpt-5\.5$/i.test(id))
    || models.find(id => /luna/i.test(id))
    || null;
  if (cheap) {
    await page.locator(`#model-list [data-model="${cheap}"]`).click();
  }
  await page.locator('#session-settings-close').click();
  return { picked: cheap, models };
}

async function send(page, text) {
  await page.locator('#msg-input').fill(text);
  await page.locator('#send-btn').click();
}

const findings = [];
function note(level, title, detail) {
  findings.push({ level, title, detail });
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
  await page.screenshot({ path: join(OUT, '01-first-paint.png'), fullPage: true });
  const firstChip = await page.locator('#model-trigger-text').textContent();
  if ((firstChip || '').trim() === '模型') {
    note('P0', '首屏模型胶囊仍显示占位「模型」');
  }

  const model = await pickCheapModel(page);
  console.log('[live] models', model.models.join(', ') || '(none)');
  console.log('[live] picked', model.picked || '(default)');
  if (!model.picked) note('P1', '没有挑到 mini 档模型', model.models.join(', ') || '模型列表空');
  await page.screenshot({ path: join(OUT, '02-after-model.png') });

  await page.locator('#menu-btn').click();
  await page.locator('#drawer').waitFor({ state: 'visible', timeout: 8_000 });
  const settings = page.locator('#btn-general-settings');
  if (await settings.count() && !(await page.locator('#native-mcp-btn').isVisible())) {
    await settings.click();
    await page.locator('#settings-sheet').waitFor({ state: 'visible', timeout: 8_000 });
  }
  await page.locator('#native-mcp-btn').click();
  await page.locator('#native-panel').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, '02b-mcp-panel.png'), fullPage: true });
  const mcpPanel = await page.evaluate(() => {
    const doc = globalThis.document;
    return {
      panel: (doc.querySelector('#native-panel')?.innerText || '').replace(/\s+/g, ' ').trim(),
      stream: (doc.querySelector('#messages')?.innerText || '').trim(),
      errorBubbles: [...doc.querySelectorAll('#messages .error-msg')].map(el => el.innerText.trim()),
    };
  });
  if (/unknown variant|MCP read failed/i.test(mcpPanel.stream) || mcpPanel.errorBubbles.some(s => /unknown variant|MCP read failed/i.test(s))) {
    note('P0', '打开 MCP 面板把协议错误写进了对话', mcpPanel.errorBubbles.join(' | ') || mcpPanel.stream.slice(0, 200));
  } else {
    note('ok', '打开 MCP 面板没有污染对话');
  }
  if (!/MCP|node_repl|github|No MCP servers/i.test(mcpPanel.panel)) {
    note('P0', 'MCP 面板是空的或没打开', mcpPanel.panel.slice(0, 200));
  } else {
    note('ok', 'MCP 面板有内容', mcpPanel.panel.slice(0, 160));
  }
  await page.locator('#native-panel [data-close-native]').click().catch(() => {});
  await page.locator('#drawer-close').click().catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});

  await send(page, '你是谁？用一句话介绍自己，不要调用工具。');
  await page.locator('.msg.user').last().waitFor({ timeout: 10_000 });
  await waitTurnStarted(page);
  await waitIdle(page);
  await page.screenshot({ path: join(OUT, '03-whoami.png'), fullPage: true });
  const who = await inspectTranscript(page);
  if (who.hasRawLabel || who.raw > 0) note('P0', '「你是谁」消息流出现 Raw JSON', `raw=${who.raw}`);
  if (who.mcpProgress.length) note('P0', 'MCP 过程态进了消息流', who.mcpProgress.join(' | '));
  if (who.englishInfra.length) note('P0', '英文协议句进了消息流', who.englishInfra.join(' | '));
  if (who.threadIds.length) note('P0', 'thread id / 压缩回执进了消息流', who.threadIds.join(' | '));
  if (!who.assistant.length) note('P0', '「你是谁」没有助手回复', JSON.stringify(who.system));
  if (who.system.length) note('P1', '「你是谁」仍有系统气泡', who.system.join(' | '));
  else note('ok', '「你是谁」消息流干净');
  if (who.copyText && !who.copyText.includes('复制')) {
    note('P1', '复制按钮没有「复制」二字', who.copyText);
  } else if (who.copyText.includes('复制')) {
    note('ok', '复制按钮带文字');
  }
  if (who.modelChip === '模型') note('P0', '模型胶囊仍是占位「模型」');
  if (who.offlineQueue.some(s => /offline queue|运行时/i.test(s))) {
    note('P0', '队列文案仍是内部词', who.offlineQueue.join(' | '));
  }

  await waitIdle(page);
  await page.locator('#msg-input').fill('/help');
  await page.locator('#send-btn').click();
  await page.locator('#slash-popup').waitFor({ timeout: 8_000 });
  await page.screenshot({ path: join(OUT, '04-help.png') });
  const helpDump = await page.locator('.msg.system-msg.slash-help').count();
  if (helpDump > 0) note('P0', '/help 仍把命令表写进消息流');
  else note('ok', '/help 打开挑选层');
  await page.keyboard.press('Escape');
  await page.locator('#msg-input').fill('');

  await waitIdle(page);
  await send(page, '只读列出当前目录的文件名，不要修改任何文件。');
  await page.locator('.msg.user').last().waitFor({ timeout: 10_000 });
  await waitTurnStarted(page);
  const approval = page.locator('.tool-card').filter({ hasText: '需要审批' }).last();
  const sawApproval = await approval.waitFor({ state: 'visible', timeout: TURN_MS }).then(() => true).catch(() => false);
  if (sawApproval) {
    await page.screenshot({ path: join(OUT, '05-approval.png'), fullPage: true });
    await approval.getByRole('button', { name: '批准' }).click();
  }
  await waitIdle(page);
  await page.screenshot({ path: join(OUT, '06-list-files.png'), fullPage: true });
  const listed = await inspectTranscript(page);
  if (listed.hasRawLabel || listed.raw > 0) note('P0', '列文件后出现 Raw JSON', `raw=${listed.raw}`);
  if (listed.mcpProgress.length) note('P0', '列文件后 MCP 过程态进流', listed.mcpProgress.join(' | '));
  if (listed.englishInfra.length) note('P0', '列文件后英文协议句进流', listed.englishInfra.join(' | '));
  if (listed.outcome?.clipped) note('P0', '本轮结果卡被输入框挡住', listed.outcome.label);
  else if (listed.outcome) note('ok', '本轮结果卡在视口内');
  if (listed.offlineQueue.some(s => /offline queue|运行时/i.test(s))) {
    note('P0', '列文件后队列文案仍是内部词', listed.offlineQueue.join(' | '));
  }

  writeFileSync(join(OUT, 'findings.json'), `${JSON.stringify({ model, mcpPanel, who, listed, findings }, null, 2)}\n`);
  const p0 = findings.filter(f => f.level === 'P0');
  console.log(`[live] screenshots ${OUT}`);
  console.log(`[live] P0=${p0.length} total=${findings.length}`);
  if (p0.length) process.exitCode = 2;
} catch (err) {
  console.error('[live] FAIL', err);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* noop */ }
  try { child.kill('SIGTERM'); } catch { /* noop */ }
}
