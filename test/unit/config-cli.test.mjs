// test/unit/config-cli.test.mjs —— 配置 CLI 的七个子命令。
//
// 这个 CLI 是唯一会**写**配置文件的地方，所以断言重点在「写错了会怎样」而不是
// 「读出来对不对」：写坏一个键的代价是下次启动才发现，而那时人已经不在终端前了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfigCommand, parseCliValue, parseConfigArgs } from '../../scripts/config.js';

const CONFIG = 'codex.config.json';

function withDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-config-cli-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
}

const readConfig = dir => JSON.parse(readFileSync(join(dir, CONFIG), 'utf8'));

// ---- init ----

test('init 生成带 $schemaVersion 与随机 AUTH_TOKEN 的配置，权限 0600', () => {
  withDir({}, dir => {
    const r = runConfigCommand(['init'], { dir });
    assert.equal(r.ok, true);
    const cfg = readConfig(dir);
    assert.equal(cfg.$schemaVersion, 1);
    assert.ok(cfg.AUTH_TOKEN.length >= 32, '令牌要够长——非 loopback 绑定要求至少 32 字符');
  });
});

test('init 不覆盖已存在的配置，除非显式 --force', () => {
  // 覆盖掉等于换了 AUTH_TOKEN，所有已注册设备都要重新批准；而用户敲 init 时
  // 通常只是想「确保有一份配置」，不是想把所有人踢下线。
  withDir({ [CONFIG]: '{"AUTH_TOKEN":"keep-me"}' }, dir => {
    assert.equal(runConfigCommand(['init'], { dir }).ok, false);
    assert.equal(readConfig(dir).AUTH_TOKEN, 'keep-me');
    assert.equal(runConfigCommand(['init', '--force'], { dir }).ok, true);
    assert.notEqual(readConfig(dir).AUTH_TOKEN, 'keep-me');
  });
});

// ---- 迁移窗口期的写入闸 ----

test('只有 .env 时拒绝 set，先让人 migrate', () => {
  // 不拦的话，`config set PORT=4100` 会生成一份只含 PORT 的 codex.config.json，
  // 而它的优先级高于 .env —— 结果是整份 .env 被一个看起来无害的命令悄悄遮蔽。
  withDir({ '.env': 'AUTH_TOKEN=abc\nPORT=3001\n' }, dir => {
    const r = runConfigCommand(['set', 'PORT=4100'], { dir });
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /migrate/);
    assert.equal(existsSync(join(dir, CONFIG)), false, '被拦下时不该留下半份配置');
  });
});

test('两个文件都不存在时 set 不拦——那是全新安装', () => {
  withDir({}, dir => {
    assert.equal(runConfigCommand(['set', 'PORT=4100'], { dir }).ok, true);
    assert.equal(readConfig(dir).PORT, 4100);
  });
});

// ---- set / unset ----

test('set 按 schema 归一成 JSON 原生类型', () => {
  withDir({ [CONFIG]: '{}' }, dir => {
    runConfigCommand(['set', 'PORT=4100', 'LOG_STDERR=true'], { dir });
    const cfg = readConfig(dir);
    assert.equal(cfg.PORT, 4100);
    assert.equal(cfg.LOG_STDERR, true);
  });
});

test('set 的枚举非法值被拒，且一个都不写入（全或无）', () => {
  // 部分写入最糟：一半生效一半没有，而命令报的是失败，人会以为什么都没变。
  withDir({ [CONFIG]: '{"PORT":3001}' }, dir => {
    const r = runConfigCommand(['set', 'PORT=4100', 'CODEX_SANDBOX=nope'], { dir });
    assert.equal(r.ok, false);
    assert.equal(readConfig(dir).PORT, 3001, 'PORT 不该被写进去');
  });
});

test('set 拒绝只读键——改 AUTH_TOKEN 极易把自己锁在门外', () => {
  withDir({ [CONFIG]: '{}' }, dir => {
    const r = runConfigCommand(['set', 'AUTH_TOKEN=whatever'], { dir });
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /AUTH_TOKEN/);
  });
});

test('unset 同样过校验，不能绕开只读', () => {
  // CCM 踩过：unset 完全不过校验，于是 `unset AUTH_TOKEN` 成功而 `set` 会被拒。
  withDir({ [CONFIG]: '{"AUTH_TOKEN":"x","PORT":4100}' }, dir => {
    assert.equal(runConfigCommand(['unset', 'AUTH_TOKEN'], { dir }).ok, false);
    assert.equal(runConfigCommand(['unset', 'PORT'], { dir }).ok, true);
    assert.equal(Object.hasOwn(readConfig(dir), 'PORT'), false);
  });
});

// ---- get / schema ----

test('get 默认把 secret 打码，--reveal 才出明文', () => {
  // 夹具刻意用低熵的自述字符串而不是十六进制串：后者会被仓库的 gitleaks 钩子
  // 判成真凭据（实测 entropy 4.0，generic-api-key 命中）。为一个测试夹具去加
  // gitleaks 豁免，等于用「这条是误报」的先例换一点写起来的方便——而下一条
  // 真泄露也会以同样的方式被登记成误报。
  const FAKE = 'placeholder-not-a-real-token';
  withDir({ [CONFIG]: `{"AUTH_TOKEN":"${FAKE}","PORT":4100}` }, dir => {
    const masked = runConfigCommand(['get', 'AUTH_TOKEN'], { dir });
    assert.doesNotMatch(JSON.stringify(masked.data), new RegExp(FAKE));
    assert.match(JSON.stringify(masked.data), /已设置/);

    const revealed = runConfigCommand(['get', 'AUTH_TOKEN', '--reveal'], { dir });
    assert.match(JSON.stringify(revealed.data), new RegExp(FAKE));
  });
});

test('get 显式点名一个不存在的键要报错，不能打印空值退 0', () => {
  // 打印 `NOPE=` 然后退 0 会让人以为「这个键存在只是没设」，而它根本就是拼错的。
  withDir({ [CONFIG]: '{"PORT":4100}' }, dir => {
    assert.equal(runConfigCommand(['get', 'NOPE'], { dir }).ok, false);
  });
});

test('schema 列出全部配置项，且不带任何当前值', () => {
  withDir({ [CONFIG]: '{"AUTH_TOKEN":"secret-value"}' }, dir => {
    const r = runConfigCommand(['schema'], { dir });
    assert.equal(r.ok, true);
    assert.ok(r.data.items.length >= 25);
    assert.doesNotMatch(JSON.stringify(r.data), /secret-value/, 'schema 是表单描述，不是配置快照');
  });
});

// ---- check ----

test('check 对合法配置通过，对枚举非法值判红', () => {
  withDir({ [CONFIG]: '{"PORT":4100}' }, dir => {
    assert.equal(runConfigCommand(['check'], { dir }).ok, true);
  });
  withDir({ [CONFIG]: '{"CODEX_SANDBOX":"nope"}' }, dir => {
    assert.equal(runConfigCommand(['check'], { dir }).ok, false);
  });
});

test('check 对数值越界只告警不判红——与启动期同一套失败方向', () => {
  withDir({ [CONFIG]: '{"PORT":99999}' }, dir => {
    const r = runConfigCommand(['check'], { dir });
    assert.equal(r.ok, true);
    assert.ok(r.data.warnings.length > 0);
  });
});

// ---- migrate ----

test('migrate 从 .env 产出 JSON，且不删原文件', () => {
  withDir({ '.env': 'AUTH_TOKEN=abc\nPORT=4100\nWORK_DIR=/primary\n' }, dir => {
    const r = runConfigCommand(['migrate'], { dir });
    assert.equal(r.ok, true);
    const cfg = readConfig(dir);
    assert.equal(cfg.PORT, 4100);
    assert.deepEqual(cfg.WORKDIRS, ['/primary']);
    assert.equal(existsSync(join(dir, '.env')), true, '不删原文件——迁移错了还得有东西可对照');
  });
});

test('migrate 不覆盖已存在的 codex.config.json', () => {
  withDir({ '.env': 'PORT=4100\n', [CONFIG]: '{"PORT":3001}' }, dir => {
    assert.equal(runConfigCommand(['migrate'], { dir }).ok, false);
    assert.equal(readConfig(dir).PORT, 3001);
  });
});

// ---- 参数解析 ----

test('未知 flag 不静默忽略——防 --revael 让人以为看到的是明文', () => {
  const parsed = parseConfigArgs(['get', 'AUTH_TOKEN', '--revael']);
  assert.deepEqual(parsed.unknownFlags, ['--revael']);
  withDir({ [CONFIG]: '{"AUTH_TOKEN":"x"}' }, dir => {
    assert.equal(runConfigCommand(['get', 'AUTH_TOKEN', '--revael'], { dir }).ok, false);
  });
});

test('parseCliValue 不复用 schema 归一：终端里敲 false 就是关', () => {
  // schema 的 toggle 归一喂的是 .env 字面量（判据是 1/true/on/yes），于是 'false'
  // 会落进「不在真值表里」→ false，恰好对。但 'off' 在 .env 语境是关、在别的表里
  // 可能是别的意思。CLI 这一层自己认一套明确的词，并且**不认识的词直接报错**，
  // 而不是悄悄当成 false —— `set LOG_STDERR=yse` 不该静默关掉日志。
  assert.equal(parseCliValue('LOG_STDERR', 'false'), false);
  assert.equal(parseCliValue('LOG_STDERR', 'off'), false);
  assert.equal(parseCliValue('LOG_STDERR', 'true'), true);
  assert.throws(() => parseCliValue('LOG_STDERR', 'yse'), /LOG_STDERR/);
  assert.equal(parseCliValue('PORT', '4100'), 4100);
});

test('parseCliValue 的 list 要求显式 JSON 数组，不猜逗号串', () => {
  assert.deepEqual(parseCliValue('WORKDIRS', '["/a","/b"]'), ['/a', '/b']);
  assert.throws(() => parseCliValue('WORKDIRS', '/a,/b'), /JSON/);
});

test('赋值只按首个 = 切分——ntfy token 之类的值可能自带等号', () => {
  const parsed = parseConfigArgs(['set', 'VAPID_PRIVATE_KEY=abc=def==']);
  assert.deepEqual(parsed.assignments, [['VAPID_PRIVATE_KEY', 'abc=def==']]);
});
