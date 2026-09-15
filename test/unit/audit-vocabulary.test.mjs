// test/unit/audit-vocabulary.test.mjs —— 新增的四类审计事件。
//
// 审计的价值全在「出事之后查得到」。没测过的留痕与没有留痕在平时完全等价——
// 差别只在你真正需要它的那一天才显形，而那时已经晚了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneExpiredUploads, saveAttachments, decodeAttachments } from '../../src/files/uploads.js';
import { runConfigCommand } from '../../scripts/config.js';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-audit-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
}
async function withDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-audit-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
}

// ---- retention_cleanup 的前提：清理要数得出删了多少 ----

test('pruneExpiredUploads 报出删除与扫描的数量', async () => {
  // 此前它什么都不返回，于是「附件不见了」在日志里没有任何落点，而用户会以为是
  // 上传失败——两件事的排查方向完全相反。
  await withDirAsync(async dir => {
    const uploads = join(dir, '.ccm-uploads');
    mkdirSync(uploads, { recursive: true });
    const old = join(uploads, 'old.txt');
    const fresh = join(uploads, 'fresh.txt');
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'y');
    const longAgo = Date.now() / 1000 - 48 * 3600;
    utimesSync(old, longAgo, longAgo);

    const result = await pruneExpiredUploads(dir, 24 * 3600 * 1000);
    assert.equal(result.removed, 1);
    assert.equal(result.scanned, 2);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true, '未过期的不能被删');
  });
});

test('没有上传目录时返回同样的形状，调用方不必分两种情况处理', async () => {
  await withDirAsync(async dir => {
    assert.deepEqual(await pruneExpiredUploads(dir), { removed: 0, scanned: 0 });
    assert.deepEqual(await pruneExpiredUploads(''), { removed: 0, scanned: 0 });
  });
});

// ---- upload_write 的前提：落盘要报出字节数 ----

test('saveAttachments 报出每份附件的大小，供审计只记事实性元数据', async () => {
  await withDirAsync(async dir => {
    const attachments = [{ name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('hello').toString('base64') }];
    const saved = await saveAttachments(dir, attachments, decodeAttachments(attachments).decoded);
    assert.equal(saved[0].size, 5);
  });
});

// ---- config_changed ----

test('config set 往安全审计写一条，只记键名与前后有没有值', () => {
  // 配置里有 CODEX_SANDBOX、CODEX_ALLOW_INSECURE_REMOTE 这些直接决定安全边界的项。
  // 改了没痕迹意味着事后无法回答「谁把沙箱关了」。
  withDir(dir => {
    const dataDir = join(dir, 'data');
    const previous = process.env.CODEX_DATA_DIR;
    process.env.CODEX_DATA_DIR = dataDir;
    try {
      writeFileSync(join(dir, 'codex.config.json'), '{"PORT":3001}');
      assert.equal(runConfigCommand(['set', 'CODEX_SANDBOX=read-only'], { dir }).ok, true);

      const lines = readFileSync(join(dataDir, 'security-audit.jsonl'), 'utf8').trim().split('\n');
      const record = JSON.parse(lines.at(-1));
      assert.equal(record.event, 'config_changed');
      assert.equal(record.actor, 'cli');
      assert.deepEqual(record.keys, ['CODEX_SANDBOX']);
      assert.equal(record.transitions.CODEX_SANDBOX, 'unset->set');
      // 审计文件不该成为第二处凭据存放点。
      assert.doesNotMatch(JSON.stringify(record), /read-only/, '绝不记值本身');
    } finally {
      if (previous === undefined) delete process.env.CODEX_DATA_DIR;
      else process.env.CODEX_DATA_DIR = previous;
    }
  });
});

test('transitions 区分「本来就没有」与「被清空了」', () => {
  withDir(dir => {
    const dataDir = join(dir, 'data');
    const previous = process.env.CODEX_DATA_DIR;
    process.env.CODEX_DATA_DIR = dataDir;
    try {
      writeFileSync(join(dir, 'codex.config.json'), '{"PORT":4100}');
      runConfigCommand(['unset', 'PORT'], { dir });
      const lines = readFileSync(join(dataDir, 'security-audit.jsonl'), 'utf8').trim().split('\n');
      assert.equal(JSON.parse(lines.at(-1)).transitions.PORT, 'set->unset');
    } finally {
      if (previous === undefined) delete process.env.CODEX_DATA_DIR;
      else process.env.CODEX_DATA_DIR = previous;
    }
  });
});

test('留痕失败不阻断配置写入——配不上比记不上严重', () => {
  withDir(dir => {
    const previous = process.env.CODEX_DATA_DIR;
    // 指向一个不可能写入的路径
    process.env.CODEX_DATA_DIR = '/proc/nonexistent-ccm-audit';
    try {
      writeFileSync(join(dir, 'codex.config.json'), '{}');
      assert.equal(runConfigCommand(['set', 'PORT=4100'], { dir }).ok, true);
      assert.equal(JSON.parse(readFileSync(join(dir, 'codex.config.json'), 'utf8')).PORT, 4100);
    } finally {
      if (previous === undefined) delete process.env.CODEX_DATA_DIR;
      else process.env.CODEX_DATA_DIR = previous;
    }
  });
});
