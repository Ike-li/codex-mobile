import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const ICONS = new URL('public/icons/', ROOT);

function readText(path) {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

function pngDimensions(path) {
  const png = readFileSync(new URL(path, ICONS));
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', `${path} is a PNG`);
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

test('PWA icon source stays editable and drives the generated family', () => {
  const svg = readText('public/icons/icon.svg');
  const officialBlossom = readText('public/icons/openai-blossom-official.svg');
  const generator = readText('scripts/gen-icons.js');

  const officialKnot = officialBlossom.match(/<path d="(M249\.176[^"]+)" fill="black"\/>/)?.[1];
  const compositeKnot = svg.match(/<path id="openai-knot" d="([^"]+)"\/>/)?.[1];

  assert.doesNotMatch(svg, /<text\b/i, 'icon source must not depend on installed fonts');
  assert.match(svg, /<rect\b[^>]*width="512"[^>]*height="512"/i);
  assert.match(svg, /id="openai-knot"/);
  assert.match(svg, /id="terminal-chevron"/);
  assert.equal(
    createHash('sha256').update(officialBlossom).digest('hex'),
    '01485e70cea6df8422f5abc643fbbd3c153442cc41da0e7d8e7451801ebf26e2',
    'the archived Blossom source must remain byte-for-byte identical to the official asset',
  );
  assert.ok(officialKnot, 'official Blossom source exposes the primary mark path');
  assert.equal(compositeKnot, officialKnot, 'composite icon must reuse the official Blossom geometry');
  assert.match(generator, /public['"],\s*['"]icons/);
  assert.match(generator, /const BG = '#FFFFFF'/);
});

test('manifest, Apple Touch, and Web Push use the generated icon family', () => {
  const manifest = JSON.parse(readText('public/manifest.webmanifest'));
  const index = readText('public/index.html');
  const sw = readText('public/js/sw.js');

  assert.deepEqual(manifest.icons, [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ]);
  assert.match(index, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon-180\.png"/);
  assert.match(sw, /icon:\s+'\/icons\/icon-192\.png'/);
  assert.match(sw, /badge:\s+'\/icons\/icon-192\.png'/);
});

test('generated icon PNGs have the declared dimensions', () => {
  const expected = new Map([
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-maskable-192.png', 192],
    ['icon-maskable-512.png', 512],
    ['apple-touch-icon-180.png', 180],
  ]);

  for (const [name, size] of expected) {
    assert.equal(existsSync(new URL(name, ICONS)), true, `${name} exists`);
    assert.deepEqual(pngDimensions(name), { width: size, height: size });
  }
});
