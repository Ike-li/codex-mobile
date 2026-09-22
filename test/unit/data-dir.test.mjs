// test/unit/data-dir.test.mjs —— 状态目录解析的两条承重不变量。
//
// 这两条都属于「写错了不会报错，只会把文件写到别处」那一类，所以必须有测试钉着。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveDataDir, dataFile, PROJECT_ROOT } from '../../src/shared/data-dir.js';

test('env 在函数体内读：import 之后再改 CODEX_DATA_DIR 仍然生效', () => {
  // 这是承重的那条。写成模块级常量的话，本模块的顶层会在 server.js 的
  // dotenv.config() **之前**求值（静态 import 在模块链接阶段完成），于是
  // .env 里的 CODEX_DATA_DIR 静默失效、状态写回仓库 data/，而没有任何报错。
  const before = resolveDataDir({ CODEX_DATA_DIR: '/tmp/first' });
  const after = resolveDataDir({ CODEX_DATA_DIR: '/tmp/second' });
  assert.equal(before, '/tmp/first');
  assert.equal(after, '/tmp/second', '两次调用拿到同一个值 = 顶层缓存了，CODEX_DATA_DIR 会静默失效');
});

test('缺省解析到仓库根的 data/，不是 src/ 或 src/shared/ 下面', () => {
  // src/shared/ 距仓库根是**两层**。少写一层会让 data/ 解析到 src/data/，
  // 而这件事不会报任何错——它只是安静地换了个地方写文件，直到有人发现
  // 设备表和审计对不上。
  assert.equal(resolveDataDir({}), join(PROJECT_ROOT, 'data'));
  assert.doesNotMatch(resolveDataDir({}), /\/src(\/|$)/,
    '解析进了 src/ 下面——上溯层数写错了');
});

test('空串按未设置处理，不解析成当前目录', () => {
  // `export CODEX_DATA_DIR=` 在 shell 里是很自然的「取消设置」写法，
  // 而 `join('', 'x')` 会塌成相对路径 'x'，落到进程 cwd —— 那取决于
  // 谁在哪里起的 server，是最难复现的一类问题。
  assert.equal(resolveDataDir({ CODEX_DATA_DIR: '' }), join(PROJECT_ROOT, 'data'));
});

test('dataFile 拼在解析后的根上，并且同样在调用时求值', () => {
  assert.equal(dataFile('devices.json', { CODEX_DATA_DIR: '/tmp/d' }), '/tmp/d/devices.json');
  assert.equal(dataFile('a.json', {}), join(PROJECT_ROOT, 'data', 'a.json'));
});

test('缺省参数走 process.env，与显式注入一致', () => {
  const previous = process.env.CODEX_DATA_DIR;
  try {
    process.env.CODEX_DATA_DIR = '/tmp/from-process-env';
    assert.equal(resolveDataDir(), '/tmp/from-process-env');
  } finally {
    if (previous === undefined) delete process.env.CODEX_DATA_DIR;
    else process.env.CODEX_DATA_DIR = previous;
  }
});
