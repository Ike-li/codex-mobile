// 从 public/icons/icon.svg 派生 GitHub 社交预览图（1280×640，Open Graph 2:1）。
// 配色沿用 PWA：底色取 manifest 的 background_color #f5f0e8，墨色取 icon.svg 的 #20201E。
// 产物需手动上传到仓库 Settings → Social preview，GitHub 没有对应的 API。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..');
const OUT = process.argv[2] ?? join(ROOT, '.github', 'social-preview.png');

const W = 1280;
const H = 640;
const BG = '#f5f0e8';
const INK = '#20201E';
const MUTED = '#6b675f';

const icon = readFileSync(join(ROOT, 'public/icons/icon.svg'), 'utf8')
  .replace(/<\?xml[^>]*\?>/i, '')
  .replace(/<svg\b/, '<svg width="168" height="168"');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width:${W}px; height:${H}px; background:${BG}; color:${INK};
    font-family:-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
    display:flex; flex-direction:column; justify-content:center;
    padding:0 96px; -webkit-font-smoothing:antialiased;
  }
  .row { display:flex; align-items:center; gap:36px; }
  .mark { width:168px; height:168px; flex:none; }
  h1 { font-size:104px; font-weight:700; letter-spacing:-3.5px; line-height:1; }
  .tag { font-size:48px; font-weight:500; margin-top:40px; line-height:1.28; }
  .zh { font-size:31px; color:${MUTED}; margin-top:14px; }
  .rule { height:3px; background:${INK}; opacity:.14; margin:40px 0 28px; }
  .chips { display:flex; gap:16px; flex-wrap:wrap; }
  .chip {
    font-size:29px; color:${INK}; border:2px solid rgba(32,32,30,.22);
    border-radius:999px; padding:10px 24px; white-space:nowrap;
  }
</style></head><body>
  <div class="row">${icon}<h1>codex-mobile</h1></div>
  <div class="tag">Control your local Codex CLI from your phone.</div>
  <div class="zh">手机远程控制本地 Codex CLI 的自托管控制面</div>
  <div class="rule"></div>
  <div class="chips">
    <span class="chip">self-hosted</span>
    <span class="chip">custom <b>base_url</b> gateways</span>
    <span class="chip">native Codex threads</span>
    <span class="chip">PWA</span>
  </div>
</body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  // Chromium 偶发 `Page.captureScreenshot` 协议错误（实测复现过一次，重跑即过）。
  // 一次性资产脚本失败一次就得人工重来，所以这里自己重试而不是把它甩给调用者。
  let png;
  for (let attempt = 1; ; attempt += 1) {
    try {
      png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      console.warn(`截图第 ${attempt} 次失败，重试：${err.message.split('\n')[0]}`);
      await page.waitForTimeout(250);
    }
  }
  writeFileSync(OUT, png);
  console.log(`✔ ${OUT} (${W}×${H}, ${(png.length / 1024).toFixed(0)}KB / GitHub 上限 1MB)`);
} finally {
  await browser.close();
}
