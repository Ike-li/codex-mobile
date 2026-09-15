// test/unit/uploads-hardening.test.mjs —— 落盘名收敛与图片识别。
//
// 这两件都属于「写错了不会报错、只会静默换一个行为」：文件名归一漏一步，用户看到的是
// 一个隐藏文件；图片识别不出来，附件会以 mention 而不是 localImage 下发，模型就"看不见"
// 那张图——而界面上一切正常。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveAttachments, decodeAttachments } from '../../src/files/uploads.js';

// async：saveAttachments 是异步的，同步版的 finally 会在落盘完成前就把目录删掉，
// 于是每条用例都因 ENOENT 变红——那种红看起来和「发现了缺陷」一模一样。
async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-upload-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
}

/** 落盘名形如 `${ts}-${8位hex}-${sanitized}`，取第三段之后的部分。 */
const savedNameOf = absPath => absPath.split('/').pop().replace(/^\d+-[0-9a-f]{8}-/, '');

const b64 = text => Buffer.from(text).toString('base64');

async function saveOne(dir, name, dataBase64 = b64('hello')) {
  const attachments = [{ name, mimeType: 'text/plain', data: dataBase64 }];
  const decoded = decodeAttachments(attachments);
  assert.equal(decoded.error, undefined, decoded.error);
  return saveAttachments(dir, attachments, decoded.decoded);
}

// ---- 文件名归一 ----

test('前导空白（含 BOM）不能让前导点逃过剥离', async () => {
  // 原实现是 `.replace(/^\.+/, '').trim()` —— 去点在前、trim 在后。于是 "<BOM>..evil"
  // 在去点那一步看到的首字符是 BOM 而不是点，点原样留下，trim 再把 BOM 抹掉，
  // 结果是 "..evil"：一个隐藏文件，而 "..evil" 直接传进来时得到的却是 "evil"。
  // 同一个意图的两个输入归一到不同结果，就说明这一步的顺序是错的。
  await withDir(async dir => {
    for (const input of ['﻿..evil', '  ..evil', ' ..evil', '..evil']) {
      const [saved] = await saveOne(dir, input);
      assert.equal(savedNameOf(saved.absPath), 'evil', `${JSON.stringify(input)} 没有归一到 evil`);
    }
  });
});

test('普通的点开头文件名仍然被剥离成非隐藏文件', async () => {
  await withDir(async dir => {
    const [saved] = await saveOne(dir, '.bashrc');
    assert.equal(savedNameOf(saved.absPath), 'bashrc');
  });
});

test('全是空白或全是点的名字回落成 file，不会落出一个空名', async () => {
  await withDir(async dir => {
    for (const input of ['   ', '...', '﻿']) {
      const [saved] = await saveOne(dir, input);
      assert.equal(savedNameOf(saved.absPath), 'file', `${JSON.stringify(input)}`);
    }
  });
});

test('落盘名里不含路径分隔符——basename 之后再替换，双保险', async () => {
  await withDir(async dir => {
    const [saved] = await saveOne(dir, '../../etc/passwd');
    assert.equal(savedNameOf(saved.absPath), 'passwd');
    assert.equal(readdirSync(join(dir, '.ccm-uploads')).length, 1, '不该逃出上传目录');
  });
});

// ---- 图片识别 ----
//
// 识别不出来的后果不是报错，是附件以 mention 而不是 localImage 下发——模型"看不见"
// 那张图，而界面上一切正常。iOS 截图是 PNG，但相册里的照片多是 JPEG，所以只认 PNG
// 的话「从相册发一张图」这条最常见的路径是坏的。

const IMAGE_FIXTURES = {
  // 1×1 透明 PNG
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  // 最小 JPEG：SOI + APP0(JFIF) + EOI
  jpeg: Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'),
    Buffer.alloc(9), Buffer.from([0xff, 0xd9]),
  ]).toString('base64'),
  // GIF89a 头 + trailer
  gif: Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10), Buffer.from([0x3b])]).toString('base64'),
  // RIFF....WEBP。size 字段是「其后的字节数」= 总长 - 8，让夹具自己算出来，
  // 写死一个数字的话夹具与实现哪个错了分不出来。
  webp: (() => {
    const body = Buffer.concat([Buffer.from('WEBPVP8 '), Buffer.alloc(14)]);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(body.length, 0);
    return Buffer.concat([Buffer.from('RIFF'), size, body]).toString('base64');
  })(),
};

for (const [format, data] of Object.entries(IMAGE_FIXTURES)) {
  test(`${format} 按魔数识别成图片，不看扩展名`, async () => {
    await withDir(async dir => {
      // 扩展名故意写成 .bin：判据必须是内容，否则改个后缀就能骗过识别。
      const [saved] = await saveOne(dir, `shot.bin`, data);
      assert.equal(saved.kind, 'image', `${format} 没被识别成图片`);
      assert.match(saved.detectedMimeType, new RegExp(format === 'jpeg' ? 'jpeg' : format));
    });
  });
}

test('不是图片的内容不会被当成图片', async () => {
  await withDir(async dir => {
    // 扩展名说是 png，内容不是——按内容判，不按名字。
    const [saved] = await saveOne(dir, 'fake.png', b64('这不是图片'));
    assert.equal(saved.kind, 'file');
  });
});

test('只有魔数开头、没有正确结尾的截断文件不算图片', async () => {
  // 截断的图片解不出来。当成图片下发的话，失败发生在更下游、错误信息更难懂。
  await withDir(async dir => {
    const truncated = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    const [saved] = await saveOne(dir, 'truncated.png', truncated);
    assert.equal(saved.kind, 'file');
  });
});
