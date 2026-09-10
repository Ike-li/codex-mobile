// test/new-modules.test.mjs —— 本轮新增模块的单元测试。
// 红线：只测数据→数据逻辑，不测 IO 副作用（saveAttachments 除外——它写临时目录）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// ---- uploads.js ----
import { decodeAttachments, validateAttachments, saveAttachments, toEventMeta, pruneExpiredUploads } from '../uploads.js';

test('validateAttachments: null/empty passes', () => {
  assert.equal(validateAttachments(undefined), null);
  assert.equal(validateAttachments(null), null);
  assert.equal(validateAttachments([]), null);
});

test('validateAttachments rejects every supplied non-array value', () => {
  for (const value of ['base64', { data: 'aA==' }, 1, true]) {
    assert.equal(validateAttachments(value), '附件必须是数组');
  }
});

test('validateAttachments: valid single file passes', () => {
  const err = validateAttachments([{ name: 'a.txt', mimeType: 'text/plain', data: 'aGVsbG8=' }]);
  assert.equal(err, null);
});

test('validateAttachments: missing data field fails', () => {
  const err = validateAttachments([{ name: 'a.txt', mimeType: 'text/plain' }]);
  assert.ok(err, 'should reject missing data');
  assert.match(err, /缺少数据/);
});

test('validateAttachments rejects malformed base64 instead of decoding it leniently', () => {
  const err = validateAttachments([{
    name: 'bad.txt',
    mimeType: 'text/plain',
    data: 'aGVsbG8=%%%%',
  }]);

  assert.equal(err, '附件「bad.txt」数据不是合法 base64');
});

test('validateAttachments: too many files fails', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ name: `${i}.txt`, mimeType: 'text/plain', data: 'aA==' }));
  const err = validateAttachments(many);
  assert.match(err, /过多/);
});

test('validateAttachments: file over 10MB fails', () => {
  const big = { name: 'big.bin', mimeType: 'application/octet-stream', data: 'A'.repeat(14 * 1024 * 1024) };
  const err = validateAttachments([big]);
  assert.match(err, /过大/);
});

test('saveAttachments: writes file with 0600 permissions and correct content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-test-'));
  try {
    const saved = await saveAttachments(dir, [{ name: 'hello.txt', mimeType: 'text/plain', data: Buffer.from('world').toString('base64') }]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'hello.txt');
    assert.ok(saved[0].absPath.endsWith('hello.txt'));
    assert.equal(readFileSync(saved[0].absPath, 'utf8'), 'world');
    const mode = statSync(saved[0].absPath).mode & 0o777;
    assert.equal(mode, 0o600, `permissions should be 0600, got ${mode.toString(8)}`);
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, '.ccm-uploads')).mode & 0o777, 0o700);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveAttachments repairs an existing permissive upload directory to 0700', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-existing-upload-mode-'));
  const uploadDir = join(dir, '.ccm-uploads');
  try {
    mkdirSync(uploadDir, { mode: 0o755 });
    chmodSync(uploadDir, 0o755);
    await saveAttachments(dir, [{
      name: 'mode.txt',
      mimeType: 'text/plain',
      data: Buffer.from('mode').toString('base64'),
    }]);
    if (process.platform !== 'win32') {
      assert.equal(statSync(uploadDir).mode & 0o777, 0o700);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveAttachments does not trust a claimed image MIME type without image bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-fake-image-test-'));
  try {
    const [saved] = await saveAttachments(dir, [{
      name: 'fake.png',
      mimeType: 'image/png',
      data: Buffer.from('not actually an image').toString('base64'),
    }]);

    assert.equal(saved.kind, 'file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveAttachments marks structurally valid PNG bytes as a verified image', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-real-image-test-'));
  try {
    const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const [saved] = await saveAttachments(dir, [{
      name: 'pixel.png',
      mimeType: 'application/octet-stream',
      data: onePixelPng,
    }]);

    assert.equal(saved.kind, 'image');
    assert.equal(saved.detectedMimeType, 'image/png');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('toEventMeta: strips absPath', () => {
  const meta = toEventMeta([{ absPath: '/secret/x.txt', name: 'x.txt', mimeType: 'text/plain', size: 10 }]);
  assert.equal(meta.length, 1);
  assert.equal(meta[0].absPath, undefined, 'absPath must not leak');
  assert.equal(meta[0].name, 'x.txt');
  assert.equal(meta[0].mimeType, 'text/plain');
});

test('pruneExpiredUploads: unlinks files older than maxAgeMs and keeps fresh files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-test-'));
  const uploadsDir = join(dir, '.ccm-uploads');
  const { mkdirSync, utimesSync } = await import('node:fs');
  mkdirSync(uploadsDir, { recursive: true });

  const expiredPath = join(uploadsDir, 'expired.txt');
  const freshPath = join(uploadsDir, 'fresh.txt');

  writeFileSync(expiredPath, 'old content');
  writeFileSync(freshPath, 'new content');

  // Change mtime of expired.txt to 30 hours ago
  const oldTime = new Date(Date.now() - 30 * 60 * 60 * 1000);
  utimesSync(expiredPath, oldTime, oldTime);

  try {
    await pruneExpiredUploads(dir, 24 * 60 * 60 * 1000);
    assert.ok(!existsSync(expiredPath), 'expired.txt should be unlinked');
    assert.ok(existsSync(freshPath), 'fresh.txt should be kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- file-security.js ----
import { writeOwnerOnlyFile, isOwnerOnly } from '../file-security.js';

test('writeOwnerOnlyFile: creates file with 0600 permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-test-'));
  const f = join(dir, 'test.json');
  try {
    writeOwnerOnlyFile(f, '{}');
    assert.ok(existsSync(f));
    const mode = statSync(f).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isOwnerOnly: detects permissive files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-test-'));
  const f = join(dir, 'owner.json');
  try {
    writeOwnerOnlyFile(f, '{}');
    const mode1 = statSync(f).mode & 0o777;
    assert.ok(mode1 <= 0o600, `file shouldn't be world-readable, got ${mode1.toString(8)}`);
    // Delete and recreate with world-readable permissions
    rmSync(f);
    writeFileSync(f, '{}', { mode: 0o644 });
    assert.equal(isOwnerOnly(f, false), false, 'world-readable file should not be owner-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- statusline.js ----
test('statusline buildStatusLine: includes project name', async () => {
  const { buildStatusLine } = await import('../statusline.js');
  const payload = await buildStatusLine({ agent: null, cwd: '/home/user/my-project', versions: null });
  assert.equal(payload.project, 'my-project');
});

test('statusline buildStatusLine: null agent yields basic payload', async () => {
  const { buildStatusLine } = await import('../statusline.js');
  const payload = await buildStatusLine({ agent: null, cwd: null, versions: null });
  assert.ok(payload.ts > 0, 'should always have timestamp');
  assert.equal(payload.ctx, undefined, 'no ctx without agent usage');
});

// ---- agent-appserver.js 结构化附件 ----
import { ThreadRuntime } from '../agent-appserver.js';

test('ThreadRuntime.send queues and drains with attachments', async () => {
  const events = [];
  const session = new ThreadRuntime({
    // codexBin 见 agent-appserver.test.mjs：字面量 'codex' 会引入对宿主机 PATH 的隐式依赖。
    instanceId: 'inst_test', resumeId: null, cwd: '/tmp', codexBin: process.execPath,
    idleTimeoutMs: 600000,
    onEvent: env => events.push(env),
    onSessionId: () => {}, onExit: () => {},
  });

  // Mock child process to prevent real spawn and hang
  session.child = { stdin: { write: () => {} }, on: () => {}, kill: () => {} };
  // Mock request() to resolve immediately (no real JSON-RPC round-trip)
  session.request = async () => ({ thread: { id: 'mock_thread' } });

  const saved = [{ absPath: '/tmp/f.txt', name: 'f.txt', mimeType: 'text/plain', size: 5 }];
  const result = await session.send('hello', saved);
  // send() returns true when turn/start succeeds (mocked)
  assert.equal(typeof result, 'boolean');
  // user_message should have been emitted with attachment metadata
  const um = events.find(e => e.type === 'user_message');
  assert.ok(um, 'user_message should be emitted');
  assert.ok(um.payload.attachments, 'user_message should have attachments metadata');
  assert.equal(um.payload.attachments[0].name, 'f.txt');
});

// ---- 前端新增元素存在性 ----
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const allContent = html + '\n' + appJs;

test('frontend: instance routing stays in memory without a main-chrome tab strip', () => {
  assert.match(allContent, /handleInstances/, 'has handleInstances function');
  assert.doesNotMatch(html, /id="instance-tabs"/, 'instance tabs are not in main chrome');
  assert.match(html, /id="drawer-close"/, 'drawer has an explicit close control');
  assert.doesNotMatch(html, /id="new-session-btn"/, 'global new session is not a drawer header button');
});

test('frontend: attachment elements', () => {
  assert.match(allContent, /id="attach-btn"/, 'has attach button');
  assert.match(allContent, /id="attach-tray"/, 'has attach tray');
  assert.match(allContent, /id="file-input"/, 'has file input');
  assert.match(allContent, /readFileAsAttachment/, 'has file reader');
  assert.match(allContent, /renderAttachTray/, 'has tray renderer');
});

test('frontend: status line and new controls', () => {
  assert.match(allContent, /id="status-detail"/, 'has status detail line');
  assert.match(allContent, /handleStatusLine/, 'has status line handler');
  assert.match(allContent, /id="workdir-select"/, 'has workdir selector');
  assert.match(allContent, /id="model-input"/, 'has model input');
  assert.match(allContent, /id="perm-select"/, 'has permission selector');
});

test('frontend: PWA and push elements', () => {
  assert.match(allContent, /manifest\.webmanifest/, 'has manifest link');
  assert.match(allContent, /apple-mobile-web-app-capable/, 'has apple-mobile meta');
  assert.match(allContent, /push-subscribe-btn/, 'has push subscribe button');
});

test('frontend: history browsing uses only app-server thread/read', () => {
  assert.match(allContent, /loadNativeThreadHistory/, 'has native thread history loader');
  assert.match(allContent, /thread:history/, 'emits thread:history event');
  assert.match(allContent, /renderHistoryMessages/, 'renders normalized thread history');
  assert.doesNotMatch(allContent, /function loadHistory/, 'legacy JSONL loader is removed');
  assert.doesNotMatch(allContent, /codexSessions/, 'legacy JSONL session state is removed');
  assert.doesNotMatch(allContent, /session:history/, 'legacy JSONL event is not used');
});

test('decodeAttachments 校验的同时交出可复用的 buffer', () => {
  // 同一份 base64 此前被解码三次（校验、指纹、落盘各一次），每次都要额外分配一份。
  const data = Buffer.from('hello attachment').toString('base64');
  const result = decodeAttachments([{ name: 'a.txt', mimeType: 'text/plain', data }]);
  assert.equal(result.error, undefined);
  assert.equal(result.decoded.length, 1);
  assert.equal(result.decoded[0].toString(), 'hello attachment');
});

test('decodeAttachments 的错误与 validateAttachments 保持一致', () => {
  const bad = [{ name: 'a.txt', mimeType: 'text/plain', data: '!!!not base64!!!' }];
  assert.match(decodeAttachments(bad).error, /base64/);
  assert.equal(validateAttachments(bad), decodeAttachments(bad).error);
  assert.equal(validateAttachments([]), null);
  assert.equal(validateAttachments(undefined), null);
});

// 长文件名此前会一路走到 open() 才炸，用户拿到的是一句裸 ENAMETOOLONG 加一段宿主机
// 绝对路径。长名字不是攻击，是很平常的情况——不少导出工具会拼日期、查询串、标题生成
// 200 字符以上的名字。文件名收敛本来就该管长度，而不是把 NAME_MAX 的失败推给内核。
test('saveAttachments: 超长文件名被截短而不是让 open 抛 ENAMETOOLONG', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-longname-'));
  try {
    const longName = `${'a'.repeat(400)}.png`;
    const saved = await saveAttachments(dir, [{
      name: longName,
      mimeType: 'image/png',
      data: Buffer.from('x').toString('base64'),
    }]);

    assert.equal(saved.length, 1);
    assert.ok(existsSync(saved[0].absPath), '文件必须真的落盘');
    const onDisk = saved[0].absPath.split('/').pop();
    assert.ok(onDisk.length <= 255, `落盘文件名 ${onDisk.length} 字符，超过 NAME_MAX`);
    assert.ok(onDisk.endsWith('.png'), '截短必须保住扩展名——agent 看到的是这个名字');
    assert.equal(saved[0].name, longName, '回给前端的仍是用户原本的名字，只有磁盘上的被收敛');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveAttachments: 没有扩展名的超长文件名也能落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-longname-noext-'));
  try {
    const saved = await saveAttachments(dir, [{
      name: 'b'.repeat(400),
      mimeType: 'text/plain',
      data: Buffer.from('x').toString('base64'),
    }]);
    const onDisk = saved[0].absPath.split('/').pop();
    assert.ok(existsSync(saved[0].absPath));
    assert.ok(onDisk.length <= 255);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 变异补漏：批 4（uploads.js，SCOPE） ----

// 一个刚好合法的最小 PNG：签名 8 + IHDR(长度 4 + 'IHDR' 4 + 宽高 8 + 5 + CRC 4) + IEND 12 = 45 字节。
// 45 正好是长度下限，用它才能测到边界。
function minimalPng({ ihdrLength = 13, ihdr = 'IHDR', width = 1, height = 1, iend = true } = {}) {
  const head = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(ihdrLength); return b; })(),
    Buffer.from(ihdr, 'ascii'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(width); return b; })(),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(height); return b; })(),
    Buffer.from('0806000000', 'hex'),
    Buffer.alloc(4),
  ]);
  const tail = iend
    ? Buffer.from('0000000049454e44ae426082', 'hex')
    : Buffer.alloc(12, 0x41);
  return Buffer.concat([head, tail]);
}

async function saveOne(content, name = 'a.png') {
  const workDir = mkdtempSync(join(tmpdir(), 'ccm-uploads-mut-'));
  try {
    const attachment = { name, mimeType: 'application/octet-stream', data: content.toString('base64') };
    const { decoded, error } = decodeAttachments([attachment]);
    assert.equal(error, undefined, '前置：附件本身要能通过校验');
    const [saved] = await saveAttachments(workDir, [attachment], decoded);
    return saved;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// PNG 识别决定这个附件是以 image 还是 file 的身份交给 runtime。六个条件全部串联，
// 任一个被改成 || 都会让「随便一段 45 字节以上的数据」被当成 PNG——
// runtime 拿到的是一个声称是图片、实际不是的东西。
test('PNG 识别要求六个条件同时成立，缺一不可', async () => {
  const good = await saveOne(minimalPng());
  assert.equal(good.kind, 'image', '45 字节的合法最小 PNG 必须被识别为图片');
  assert.equal(good.detectedMimeType, 'image/png');

  const rejected = [
    ['不足 45 字节', Buffer.from('89504e470d0a1a0a', 'hex')],
    ['长度够但完全不是 PNG', Buffer.alloc(64, 0x41)],
    ['签名对但 IHDR 长度字段不是 13', minimalPng({ ihdrLength: 12 })],
    ['签名对但块名不是 IHDR', minimalPng({ ihdr: 'IHDX' })],
    ['宽为 0', minimalPng({ width: 0 })],
    ['高为 0', minimalPng({ height: 0 })],
    ['结尾不是 IEND', minimalPng({ iend: false })],
  ];
  for (const [label, content] of rejected) {
    const saved = await saveOne(content, 'x.bin');
    assert.equal(saved.kind, 'file', `${label}：不该被识别成 PNG`);
    assert.equal(saved.detectedMimeType, undefined);
  }
});

// 附件字段校验的三条早退，每条给的错误文案不同——那是用户唯一能看到的线索。
// 串错了会给出指向错误方向的提示（明明是数据没给，却说 name 缺了）。
test('附件字段校验各自给出指向真正问题的错误', () => {
  const cases = [
    ['附件不是对象', [null], /附件缺少数据/],
    ['data 缺失', [{ name: 'a', mimeType: 'text/plain' }], /附件缺少数据/],
    ['data 是空串', [{ name: 'a', mimeType: 'text/plain', data: '' }], /附件缺少数据/],
    ['data 是数字', [{ name: 'a', mimeType: 'text/plain', data: 1 }], /附件缺少数据/],
    ['name 是数字', [{ name: 1, mimeType: 'text/plain', data: 'QQ==' }], /缺少 name\/mimeType/],
    ['mimeType 缺失', [{ name: 'a', data: 'QQ==' }], /缺少 name\/mimeType/],
    ['不是数组', {}, /必须是数组/],
    ['超过 10 个', Array.from({ length: 11 }, () => ({ name: 'a', mimeType: 't', data: 'QQ==' })), /附件过多/],
  ];
  for (const [label, attachments, message] of cases) {
    const result = decodeAttachments(attachments);
    assert.match(result.error ?? '', message, label);
    assert.equal(validateAttachments(attachments), result.error, `${label}：两个入口要给同一句话`);
  }
});

test('附件总量超过上限时拒绝，而不是把 20MB 写进工作区', () => {
  const chunk = Buffer.alloc(7 * 1024 * 1024).toString('base64');
  const attachments = Array.from({ length: 3 }, (_, i) => ({
    name: `big-${i}.bin`, mimeType: 'application/octet-stream', data: chunk,
  }));
  assert.match(decodeAttachments(attachments).error ?? '', /总量过大/, '3 × 7MB 超过 20MB 上限');
});

// 落盘名的长度收敛：超长要截断并保住扩展名，因为 agent 拿到的就是这个名字。
test('落盘名超长时截断并保住短扩展名，长后缀不当扩展名', async () => {
  const exactly200 = `${'a'.repeat(196)}.txt`;
  const saved200 = await saveOne(Buffer.alloc(8), exactly200);
  assert.ok(saved200.absPath.endsWith(exactly200),
    '正好 200 的名字要原样保留，不该走进截断分支');

  const long = `${'b'.repeat(300)}.png`;
  const savedLong = await saveOne(Buffer.alloc(8), long);
  const namePart = savedLong.absPath.split(/[/\\]/).pop().replace(/^\d+-[0-9a-f]{8}-/, '');
  assert.equal(namePart.length, 200, '截断到 200');
  assert.ok(namePart.endsWith('.png'), '扩展名必须保住——被截掉会改变 agent 对文件类型的判断');

  const longExt = `${'c'.repeat(300)}.${'d'.repeat(20)}`;
  const savedLongExt = await saveOne(Buffer.alloc(8), longExt);
  const extPart = savedLongExt.absPath.split(/[/\\]/).pop().replace(/^\d+-[0-9a-f]{8}-/, '');
  assert.equal(extPart.length, 200);
  assert.ok(!extPart.includes('.'), '20 个字符的后缀不是扩展名，不该被保住');

  const boundaryExt = `${'e'.repeat(300)}.${'f'.repeat(11)}`;
  const savedBoundary = await saveOne(Buffer.alloc(8), boundaryExt);
  const boundaryPart = savedBoundary.absPath.split(/[/\\]/).pop().replace(/^\d+-[0-9a-f]{8}-/, '');
  assert.ok(boundaryPart.endsWith(`.${'f'.repeat(11)}`), '12 字符（含点）正好是上限，要保住');
});

// 清理任务的两条边界：没有上传目录是正常状态（还没人传过东西），必须安静返回；
// 上传目录被换成一个普通文件则是异常，必须报出来而不是继续 chmod / readdir。
test('清理上传目录：不存在时安静返回，被换成普通文件时报错', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'ccm-prune-none-'));
  try {
    await pruneExpiredUploads(empty);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }

  const hijacked = mkdtempSync(join(tmpdir(), 'ccm-prune-file-'));
  try {
    writeFileSync(join(hijacked, '.ccm-uploads'), 'not a directory');
    await assert.rejects(() => pruneExpiredUploads(hijacked), /必须是普通目录/,
      '上传目录被换成文件是异常，要报出来');
  } finally {
    rmSync(hijacked, { recursive: true, force: true });
  }
});
