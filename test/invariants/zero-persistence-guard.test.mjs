// test/invariants/zero-persistence-guard.test.mjs —— 守护架构决定 A2：几乎不新增持久化层。
// 守护：A2
//
// 判据不是「有没有写文件」，而是「会不会产生第二份真相」。同一个事实如果既在
// codex CLI 的宿主机状态里、又被我们独立存一份，两边迟早漂移，而用户没有办法
// 知道该信哪个 —— thread、turn、item、配置、模型列表全都必须向 app-server 现问。
//
// 允许的例外只有三类，理由写在下面的清单里。这是一道绊线而不是实现的镜像：
// 文件名从源码里抽取，只有「允许什么」是写死的。新增一个持久化文件会让它变红，
// 逼一次显式判断 —— 属于哪一类例外，还是本来就该改成向 codex 查询。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = relativePath => readFileSync(join(ROOT, relativePath), 'utf8');

// 文件名 -> 它凭什么不算「第二份真相」
const ALLOWED_STATE_FILES = new Map([
  ['enrollment-token', '本网关自己的凭证，codex 侧不存在对应事实'],
  ['trusted-devices.json', '设备表是本网关独有的信任关系，codex 不知道有哪些浏览器'],
  ['pending-devices.json', '同上，等待人工批准的队列'],
  ['push-subscriptions.json', '浏览器 Push endpoint，属于设备表的一部分'],
  ['security-audit.jsonl', 'append-only 审计，只增不改，不作为任何读路径的数据源'],
  ['host-config-audit.jsonl', '同上，宿主配置操作的审计'],
  ['read-state.json',
    '「用户在手机上看过某个 thread 到什么时刻」是本网关独有的事实：app-server 的 thread 模型里'
    + '没有「已读」这个概念（thread/list 只给 createdAt / updatedAt / recencyAt，全是 agent 侧的'
    + '活动时间），也无法从 thread 历史重建——它记录的是人的浏览行为，不是 agent 的行为。'
    + '且它是缓存类：损坏或形状不对一律当作没有，删掉最多让所有会话按新基线重来一次。'
    + '它不进任何读路径的判定——判定发生在前端，本文件只是那份判定的跨设备位点。'],
]);

/** 从源码里抽出所有落在 DATA_DIR 下的文件名。 */
function persistedFileNames(source) {
  const names = new Set();
  for (const [, name] of source.matchAll(/join\((?:DATA_DIR|dataDir\(\)),\s*'([^']+)'\)/g)) {
    names.add(name);
  }
  // dataFile('x') 是 src/shared/data-dir.js 的写法。不补这一支的话，任何走新分层的
  // 落盘点对这道闸完全不可见——而「扫不到」与「合规」在断言上一模一样。
  for (const [, name] of source.matchAll(/dataFile\(\s*'([^']+)'\s*\)/g)) {
    names.add(name);
  }
  return names;
}

test('服务端落盘的文件不超出 A2 允许的例外', () => {
  const found = new Set([
    ...persistedFileNames(read('server.js')),
    ...persistedFileNames(read('src/auth/devices.js')),
    ...persistedFileNames(read('src/sessions/read-state.js')),
  ]);
  // 扫到 0 个与「没有新增持久化」在断言上完全一样。读取列表漏一个文件、
  // 正则失配、文件改名——都会走到这里，而它们的症状都是「全绿」。
  assert.ok(found.size >= 5, `只扫出 ${found.size} 个落盘点，扫描面塌了`);

  const unexpected = [...found].filter(name => !ALLOWED_STATE_FILES.has(name));
  assert.deepEqual(
    unexpected,
    [],
    '新增了持久化文件。先回答：这个事实 codex CLI 是否已经有了？'
    + '有的话应当现问而不是自己存一份；确实是本网关独有的状态，再把它加进 ALLOWED_STATE_FILES 并写明理由。',
  );
});

test('允许清单里的每一项都仍在被使用', () => {
  const found = new Set([
    ...persistedFileNames(read('server.js')),
    ...persistedFileNames(read('src/auth/devices.js')),
    ...persistedFileNames(read('src/sessions/read-state.js')),
  ]);
  // 扫到 0 个与「没有新增持久化」在断言上完全一样。读取列表漏一个文件、
  // 正则失配、文件改名——都会走到这里，而它们的症状都是「全绿」。
  assert.ok(found.size >= 5, `只扫出 ${found.size} 个落盘点，扫描面塌了`);

  const stale = [...ALLOWED_STATE_FILES.keys()].filter(name => !found.has(name));
  assert.deepEqual(
    stale,
    [],
    '允许清单里有源码已不再写的文件 —— 清单本身也会过期，删掉它免得下次审查时被当成现状。',
  );
});

test('会话、投递账本和 needs-you 注册表都不落盘', () => {
  // 这三样是内存态，重启即失。ARCHITECTURE.md 明确写了这一点，用户据此理解
  // 「重启会清掉哪些保护和状态」。任何一处改成落盘都会改变那个承诺。
  for (const [module, symbol] of [
    ['src/sessions/message-receipt-ledger.js', '投递账本'],
    ['src/sessions/needs-you-registry.js', 'needs-you 注册表'],
    ['src/sessions/thread-registry.js', 'thread 注册表'],
  ]) {
    const source = read(module);
    assert.doesNotMatch(
      source,
      /writeFileSync|appendFileSync|writeOwnerOnlyFile|appendOwnerOnlyFile/,
      `${symbol}（${module}）开始落盘了 —— 它是重启即失的内存态，ARCHITECTURE.md 据此描述重启语义`,
    );
  }
});
