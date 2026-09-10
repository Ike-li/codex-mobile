// 从 public/icons/icon.svg 派生 PWA、通知和 Apple Touch 位图。
// 普通图标保留圆角底；maskable 图标使用满幅背景并把主图形缩进安全区。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const HERE = import.meta.dirname;
const ICONS = join(HERE, '..', 'public', 'icons');
const SRC = join(ICONS, 'icon.svg');
const BG = '#FFFFFF';

function extractMark(svg) {
  let body = svg
    .replace(/<\?xml[^>]*\?>/i, '')
    .replace(/<svg[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '')
    .trim();
  body = body.replace(
    /<rect\b[^>]*\bwidth="512"[^>]*\bheight="512"[^>]*\/?>/i,
    '',
  ).trim();
  return body;
}

function buildMaskableSvg(mark) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${BG}"/>
  <g transform="translate(256 256) scale(0.72) translate(-256 -256)">
    ${mark}
  </g>
</svg>`;
}

async function renderPng(browser, svg, size, outName) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  const sized = svg.replace(/<svg\b/, `<svg width="${size}" height="${size}"`);
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"></head>
     <body style="margin:0;padding:0;line-height:0;background:transparent">${sized}</body></html>`,
    { waitUntil: 'load' },
  );
  const png = await page.screenshot({
    type: 'png',
    clip: { x: 0, y: 0, width: size, height: size },
    omitBackground: false,
  });
  writeFileSync(join(ICONS, outName), png);
  await page.close();
  console.log(`✔ ${outName} (${size}×${size}, ${png.length}B)`);
}

const source = readFileSync(SRC, 'utf8').trim();
const mark = extractMark(source);
if (!mark || !/path|circle|rect|use/i.test(mark)) {
  console.error('icon.svg 解析主图形失败：请保留满幅 512 背景 rect 和内容层');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
try {
  await renderPng(browser, source, 192, 'icon-192.png');
  await renderPng(browser, source, 512, 'icon-512.png');
  const maskable = buildMaskableSvg(mark);
  await renderPng(browser, maskable, 192, 'icon-maskable-192.png');
  await renderPng(browser, maskable, 512, 'icon-maskable-512.png');
  await renderPng(browser, maskable, 180, 'apple-touch-icon-180.png');
} finally {
  await browser.close();
}

console.log('✅ 图标生成完成（any 192/512 · maskable 192/512 · Apple Touch 180）');
