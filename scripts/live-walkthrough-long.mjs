#!/usr/bin/env node
// scripts/live-walkthrough-long.mjs —— 隔离真机长会话：≥8 轮 + 真审批卡。会烧额度。
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = process.env.CCM_LIVE_PORT || '3240';
const URL = process.env.CCM_LIVE_URL || `http://127.0.0.1:${PORT}`;
const OUT = process.env.CCM_LIVE_OUT || '/tmp/ccm-walkthrough-long';
const TURN_MS = 180_000;

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
    return {
      userCount: doc.querySelectorAll('.msg.user').length,
      assistantCount: doc.querySelectorAll('.msg.codex .bubble').length,
      raw: doc.querySelectorAll('[data-activity="raw"], .tool-json').length,
      hasRawLabel: /Raw:/i.test(text),
      mcpProgress: system.filter(s => /MCP .+: (starting|ready|updated)/i.test(s)),
      englishInfra: system.filter(s => /Skills changed|Rate limits updated|Unsupported server request/i.test(s)),
      threadIds: system.filter(s => /Thread |已归档:|压缩完成:/i.test(s)),
      system,
      copyText: doc.querySelector('.turn-action[data-action="copy"]')?.textContent?.trim() || '',
      modelChip: doc.querySelector('#model-trigger-text')?.textContent?.trim() || '',
      heading: doc.querySelector('#empty-heading')?.textContent?.trim() || '',
      approvalCards: [...doc.querySelectorAll('.tool-card[data-card="decision"]')].map(el => ({
        title: (el.querySelector('.tool-name')?.textContent || '').trim(),
        command: (el.querySelector('.tool-cmd')?.textContent || '').trim().slice(0, 160),
        approve: Boolean(el.querySelector('.approve-btn[data-d="accept"]')),
        deny: Boolean(el.querySelector('.deny-btn')),
      })),
      lastAssistant: [...doc.querySelectorAll('.msg.codex .bubble')].at(-1)?.innerText.trim().slice(0, 280) || '',
      lastUser: [...doc.querySelectorAll('.msg.user .bubble')].at(-1)?.innerText.trim().slice(0, 160) || '',
    };
  });
}

function hygieneNotes(note, tag, snap) {
  if (snap.hasRawLabel || snap.raw > 0) note('P0', `${tag} 出现 Raw JSON`, `raw=${snap.raw}`);
  if (snap.mcpProgress.length) note('P0', `${tag} MCP 过程态进流`, snap.mcpProgress.join(' | '));
  if (snap.englishInfra.length) note('P0', `${tag} 英文协议句进流`, snap.englishInfra.join(' | '));
  if (snap.threadIds.length) note('P0', `${tag} thread id / 压缩回执进流`, snap.threadIds.join(' | '));
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
  if (cheap) await page.locator(`#model-list [data-model="${cheap}"]`).click();
  await page.locator('#session-settings-close').click();
  return { picked: cheap, models };
}

async function switchUntrusted(page) {
  await page.locator('[data-testid="composer-defaults"]').click();
  await page.locator('#session-settings').waitFor({ state: 'visible', timeout: 10_000 });
  const summary = page.locator('#settings-advanced summary');
  if (await summary.count()) {
    const open = await page.locator('#settings-advanced').evaluate(el => el.open);
    if (!open) await summary.click();
  }
  const untrusted = page.locator('#approval-list [data-approval="untrusted"]');
  await untrusted.waitFor({ state: 'visible', timeout: 10_000 });
  await untrusted.click();
  await page.locator('#session-settings-close').click();
}

async function send(page, text) {
  await page.locator('#msg-input').fill(text);
  await page.locator('#send-btn').click();
}

const TURNS = [
  { id: '01', prompt: '你是谁？用一句话介绍自己，不要调用工具。' },
  { id: '02', prompt: '只读列出当前目录的文件名，不要修改任何文件。' },
  { id: '03', prompt: 'README.md 的第一行是什么？只读，不要改文件。' },
  { id: '04', prompt: 'src/hello.js 里的函数叫什么？只读。' },
  { id: '05', prompt: '给 hello 函数加一行中文注释说明它做什么。只改这一处。' },
  { id: '06', prompt: '刚才那行注释的原文是什么？只读确认。' },
  { id: '07', prompt: '把那行注释改成英文。只改这一处。' },
  { id: '08', prompt: '贴出 src/hello.js 现在的全部内容。不要再改文件。' },
];

const APPROVAL_PROMPTS = [
  "运行 python3 -c 'print(40+2)'，只打印数字，不要改任何文件。",
  '访问 https://example.com ，只告诉我 HTTP 状态码，不要改文件。',
];

const findings = [];
function note(level, title, detail) {
  findings.push({ level, title, detail: detail || '' });
  console.log(`[${level}] ${title}${detail ? ` — ${detail}` : ''}`);
}

const { child, ready } = startServer();
let browser;
const snaps = [];
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
  await page.screenshot({ path: join(OUT, '00-first-paint.png') });
  const first = await inspectTranscript(page);
  if (first.heading && first.heading !== '这轮改什么？') {
    note('P1', '空状态标题不是「这轮改什么？」', first.heading);
  }

  const model = await pickCheapModel(page);
  console.log('[live] models', model.models.join(', ') || '(none)');
  console.log('[live] picked', model.picked || '(default)');
  if (!model.picked) note('P1', '没有挑到 mini/5.5 档模型', model.models.join(', ') || '模型列表空');

  for (const turn of TURNS) {
    console.log(`[live] turn ${turn.id}`);
    await waitIdle(page);
    await send(page, turn.prompt);
    await page.locator('.msg.user').last().waitFor({ timeout: 10_000 });
    await waitTurnStarted(page);
    await waitIdle(page);
    await page.screenshot({ path: join(OUT, `turn-${turn.id}.png`), fullPage: true });
    const snap = await inspectTranscript(page);
    hygieneNotes(note, `T${turn.id}`, snap);
    if (!snap.lastAssistant) note('P0', `T${turn.id} 没有助手回复`);
    snaps.push({ id: turn.id, prompt: turn.prompt, ...snap });
    console.log(`[live] T${turn.id} users=${snap.userCount} assistant=${snap.lastAssistant.slice(0, 80)}`);
  }

  await waitIdle(page);
  await switchUntrusted(page);
  note('ok', '已切换审批策略为仅信任命令');

  let approved = false;
  for (const [i, prompt] of APPROVAL_PROMPTS.entries()) {
    console.log(`[live] approval attempt ${i + 1}`);
    await waitIdle(page);
    await send(page, prompt);
    await page.locator('.msg.user').last().waitFor({ timeout: 10_000 });
    await waitTurnStarted(page);
    const card = page.locator('.tool-card').filter({ hasText: '需要审批' }).last();
    const saw = await card.waitFor({ state: 'visible', timeout: TURN_MS }).then(() => true).catch(() => false);
    if (!saw) {
      note('P1', `审批尝试 ${i + 1} 没有弹出审批卡`, prompt);
      await waitIdle(page);
      await page.screenshot({ path: join(OUT, `approval-miss-${i + 1}.png`), fullPage: true });
      continue;
    }
    await page.screenshot({ path: join(OUT, 'approval-card.png'), fullPage: true });
    const snap = await inspectTranscript(page);
    hygieneNotes(note, '审批卡出现时', snap);
    const info = snap.approvalCards.at(-1);
    if (!info?.approve || !info?.deny) note('P0', '审批卡缺少批准或拒绝按钮', JSON.stringify(info));
    else note('ok', '真审批卡出现', info.command);
    const approve = card.locator('.approve-btn[data-d="accept"]');
    await approve.click();
    await waitIdle(page);
    await page.screenshot({ path: join(OUT, 'approval-after.png'), fullPage: true });
    const after = await inspectTranscript(page);
    hygieneNotes(note, '批准之后', after);
    snaps.push({ id: `approval-${i + 1}`, prompt, ...after });
    approved = true;
    break;
  }
  if (!approved) note('P0', '长会话没有弹出真审批卡');

  await waitIdle(page);
  await send(page, '用一句话总结这个工作区做什么。不要调用工具。');
  await page.locator('.msg.user').last().waitFor({ timeout: 10_000 });
  await waitTurnStarted(page);
  await waitIdle(page);
  await page.screenshot({ path: join(OUT, 'turn-final.png'), fullPage: true });
  const fin = await inspectTranscript(page);
  hygieneNotes(note, '收尾', fin);
  snaps.push({ id: 'final', prompt: '总结', ...fin });

  const userTurns = fin.userCount;
  if (userTurns < 8) note('P0', `用户轮次不足 8，实际 ${userTurns}`);
  else note('ok', `长会话共 ${userTurns} 轮用户发言`);

  writeFileSync(join(OUT, 'findings.json'), `${JSON.stringify({ model, snaps, findings }, null, 2)}\n`);
  const p0 = findings.filter(f => f.level === 'P0');
  console.log(`[live] screenshots ${OUT}`);
  console.log(`[live] P0=${p0.length} total=${findings.length} users=${userTurns}`);
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
