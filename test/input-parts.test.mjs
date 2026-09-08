import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveInputParts } from '../input-parts.js';

test('resolveInputParts canonicalizes a workspace mention inside the runtime cwd', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccm-input-mention-'));
  try {
    mkdirSync(join(cwd, 'src'));
    const filePath = join(cwd, 'src', 'server.js');
    writeFileSync(filePath, 'export const ok = true;');

    const parts = await resolveInputParts([{
      kind: 'mention',
      name: 'untrusted-name',
      path: filePath,
    }], { cwd });

    assert.deepEqual(parts, [{
      kind: 'mention',
      name: 'src/server.js',
      path: realpathSync(filePath),
    }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInputParts accepts only an enabled skill returned by skills/list', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccm-input-skill-'));
  try {
    const skillPath = '/trusted/skills/release/SKILL.md';
    const parts = await resolveInputParts([{
      kind: 'skill',
      name: 'release',
      path: skillPath,
    }], {
      cwd,
      skillEntries: [{
        cwd,
        skills: [
          { name: 'disabled', path: '/trusted/skills/disabled/SKILL.md', enabled: false },
          { name: 'release', path: skillPath, enabled: true },
        ],
      }],
    });

    assert.deepEqual(parts, [{ kind: 'skill', name: 'release', path: skillPath }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInputParts admits an HTTPS image URL only through the explicit remote-image gate', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccm-input-image-url-'));
  try {
    const parts = await resolveInputParts([{
      kind: 'imageUrl',
      url: 'https://images.example.test/reference.png',
      detail: 'original',
    }], {
      cwd,
      allowRemoteImages: true,
      resolveHostname: async hostname => {
        assert.equal(hostname, 'images.example.test');
        return ['93.184.216.34'];
      },
    });

    assert.deepEqual(parts, [{
      kind: 'imageUrl',
      url: 'https://images.example.test/reference.png',
      detail: 'original',
    }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInputParts rejects site-local IPv6 remote image resolution', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccm-input-image-site-local-'));
  try {
    await assert.rejects(
      resolveInputParts([{
        kind: 'imageUrl',
        url: 'https://images.example.test/reference.png',
      }], {
        cwd,
        allowRemoteImages: true,
        resolveHostname: async () => ['fec0::1234'],
      }),
      /non-public address/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveInputParts rejects an unsupported browser-supplied part kind', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccm-input-unsupported-'));
  try {
    await assert.rejects(
      resolveInputParts([{ kind: 'rawAppServerInput', type: 'text', text: 'bypass' }], { cwd }),
      /Unsupported input part kind/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// 远程图片 URL 由浏览器提供，来自信任边界之外。默认这条路是关的；一旦显式打开，
// 每一层校验都得在真正发起请求之前挡住 —— 否则服务端就成了让人代打内网的跳板。
// 下面用一个「被调用就失败」的解析桩，确保拒绝发生在解析之前那一层。
function refuseDns(label = 'DNS') {
  return async () => { throw new Error(`${label} 不该被调用`); };
}

async function rejectsImageUrl(part, message, options = {}) {
  await assert.rejects(
    resolveInputParts([{ kind: 'imageUrl', ...part }], {
      cwd: tmpdir(),
      allowRemoteImages: true,
      resolveHostname: refuseDns(),
      ...options,
    }),
    message,
  );
}

test('远程图片 URL：畸形、超长、非 HTTPS、带凭证的一律在解析前拒绝', async () => {
  await rejectsImageUrl({ url: 'not a url' }, /URL is invalid/);
  await rejectsImageUrl({ url: '' }, /URL is invalid/);
  await rejectsImageUrl({ url: 42 }, /URL is invalid/);
  await rejectsImageUrl({ url: `https://a.example/${'x'.repeat(2100)}` }, /URL is invalid/);
  await rejectsImageUrl({ url: 'http://images.example.test/a.png' }, /HTTPS without credentials/);
  await rejectsImageUrl({ url: 'https://user@images.example.test/a.png' }, /HTTPS without credentials/);
  await rejectsImageUrl({ url: 'https://user:pw@images.example.test/a.png' }, /HTTPS without credentials/);
});

// 内网拦截实际走三条路，分开表达才不会把结论记反：
//   1. localhost 这类保留名 —— 主机名闸拦下，不查 DNS
//   2. IPv4 私网字面量 —— isIP 认出来后直接过地址闸，也不查 DNS
//   3. 其他名字（含 [::1]，方括号让 isIP 判不出来）—— 解析一次，再过地址闸
// 共同性质是三条都 fail closed；下面连「查没查 DNS」一起断言，免得日后有人
// 以为字面量也走解析，从而在错误的地方加缓存或放宽。
test('远程图片 URL：保留主机名在主机名闸拦下，不查 DNS', async () => {
  let resolved = 0;
  await rejectsImageUrl(
    { url: 'https://localhost/a.png' },
    /hostname is not allowed/,
    { resolveHostname: async () => { resolved += 1; return ['127.0.0.1']; } },
  );
  assert.equal(resolved, 0);
});

test('远程图片 URL：私网 IPv4 字面量过地址闸，不查 DNS', async () => {
  let resolved = 0;
  const countingDns = { resolveHostname: async () => { resolved += 1; return ['93.184.216.34']; } };
  for (const host of ['10.1.2.3', '192.168.0.1', '169.254.169.254', '127.0.0.1']) {
    await rejectsImageUrl({ url: `https://${host}/a.png` }, /resolves to a non-public address/, countingDns);
  }
  assert.equal(resolved, 0, 'IP 字面量不需要解析；如果这里变成非 0，说明字面量分支被绕过了');
});

test('远程图片 URL：普通主机名解析一次，解到环回地址仍然拒绝', async () => {
  let resolved = 0;
  await rejectsImageUrl(
    { url: 'https://internal.corp.example/a.png' },
    /resolves to a non-public address/,
    { resolveHostname: async () => { resolved += 1; return ['127.0.0.1']; } },
  );
  assert.equal(resolved, 1, '名字必须真的过一次解析，光看字面量拦不住内部 DNS');
});

test('远程图片 URL：解析结果只要有一个非公网地址就整体拒绝', async () => {
  for (const answer of [[], ['93.184.216.34', '127.0.0.1'], null, 'not-an-array']) {
    await rejectsImageUrl(
      { url: 'https://images.example.test/a.png' },
      /resolves to a non-public address/,
      { resolveHostname: async () => answer },
    );
  }
});

test('远程图片 URL：detail 只接受协议认可的四个取值', async () => {
  const ok = { resolveHostname: async () => ['93.184.216.34'] };
  for (const detail of ['auto', 'low', 'high', 'original']) {
    const parts = await resolveInputParts(
      [{ kind: 'imageUrl', url: 'https://images.example.test/a.png', detail }],
      { cwd: tmpdir(), allowRemoteImages: true, ...ok },
    );
    assert.equal(parts[0].detail, detail);
  }
  await rejectsImageUrl({ url: 'https://images.example.test/a.png', detail: 'huge' }, /detail is invalid/, ok);
});

test('远程图片 URL：不带 detail 时不要在结果里塞一个空字段', async () => {
  const parts = await resolveInputParts(
    [{ kind: 'imageUrl', url: 'https://images.example.test/a.png' }],
    { cwd: tmpdir(), allowRemoteImages: true, resolveHostname: async () => ['93.184.216.34'] },
  );
  assert.deepEqual(parts, [{ kind: 'imageUrl', url: 'https://images.example.test/a.png' }]);
});

test('远程图片 URL：门没打开时，连合法的公网地址也不放行', async () => {
  await assert.rejects(
    resolveInputParts([{ kind: 'imageUrl', url: 'https://images.example.test/a.png' }], {
      cwd: tmpdir(),
      resolveHostname: refuseDns(),
    }),
    /.+/,
    'allowRemoteImages 缺省即关闭，这是默认安全的那一半',
  );
});

// ---- 变异补漏：批 4（SCOPE） ----

// :43 是 mention 的**越界闸**：三个 || 里任意一个被改成 &&，整条判断就退化到只剩一个条件，
// 于是 `../` 开头的路径被放行——用户可以让 agent 读到工作区外面的任何文件。
// 三个变异全部存活，说明「刚好越界一格」这类用例一条都没有。
test('mention 不能落在 runtime cwd 之外，紧贴边界的几种写法都要挡住', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-input-escape-')));
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  try {
    const outside = join(root, 'secret.txt');
    writeFileSync(outside, 'not yours');
    writeFileSync(join(cwd, 'ok.txt'), 'yours');

    const escapes = [
      ['父目录里的兄弟文件', outside],
      ['用 .. 拼出来的同一个文件', join(cwd, '..', 'secret.txt')],
      ['cwd 自己', cwd],
      ['父目录自己', root],
    ];
    for (const [label, path] of escapes) {
      await assert.rejects(
        () => resolveInputParts([{ kind: 'mention', path }], { cwd }),
        /stay inside the runtime cwd|must reference a file/,
        `${label}：必须挡在工作区边界上`,
      );
    }

    const inside = await resolveInputParts([{ kind: 'mention', path: join(cwd, 'ok.txt') }], { cwd });
    assert.deepEqual(inside.map(part => part.name), ['ok.txt'], '界内的仍然要放行');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 入参校验的三条早退，各自的报错是运维排查的唯一线索。绕过去之后报出来的是
// realpath 的 ENOENT，读起来像「文件不存在」，而真正的问题是「参数根本没给」。
test('入参校验的报错要指向真正的问题，而不是退化成 ENOENT', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-input-guard-')));
  try {
    assert.deepEqual(await resolveInputParts(null, { cwd }), [], '不是数组就当空处理，不该抛');
    assert.deepEqual(await resolveInputParts([], { cwd }), []);

    for (const bad of ['', 123, null, undefined]) {
      await assert.rejects(
        () => resolveInputParts([{ kind: 'mention', path: 'x' }], { cwd: bad }),
        /runtime cwd/,
        `cwd=${String(bad)} 时要说清缺的是 cwd`,
      );
    }
    for (const bad of ['', 123, null, undefined]) {
      await assert.rejects(
        () => resolveInputParts([{ kind: 'mention', path: bad }], { cwd }),
        /Mention path is required/,
        `path=${String(bad)} 时要说清缺的是 path`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// 远程图片默认关闭。默认开启的后果是：没有显式配置的部署会替用户去取任意外部 URL，
// 而那正是 CODEX_ALLOW_REMOTE_IMAGES 这个开关存在的理由。
test('远程图片默认关闭，必须显式开启', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-input-remote-')));
  try {
    await assert.rejects(
      () => resolveInputParts([{ kind: 'imageUrl', url: 'https://example.com/a.png' }], { cwd }),
      /Remote image URLs are disabled/,
      '不传 allowRemoteImages 时必须是关的',
    );

    const allowed = await resolveInputParts(
      [{ kind: 'imageUrl', url: 'https://example.com/a.png' }],
      { cwd, allowRemoteImages: true, resolveHostname: async () => ['93.184.216.34'] },
    );
    assert.deepEqual(allowed, [{ kind: 'imageUrl', url: 'https://example.com/a.png' }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// URL 必须**真的是字符串**。一个 toString() 能凑出合法 URL 的对象绕过类型检查后，
// 后面的 new URL() 会照样解析成功，于是校验形同虚设——与设备凭证那次是同一类漏洞。
test('远程图片的 url 必须是字符串，toString 凑出来的不算', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-input-url-')));
  try {
    for (const [label, url] of [
      ['toString 凑出合法 URL 的对象', { toString: () => 'https://example.com/a.png' }],
      ['空串', ''],
      ['数字', 123],
      ['缺失', undefined],
      ['超长', `https://example.com/${'a'.repeat(2100)}`],
    ]) {
      await assert.rejects(
        () => resolveInputParts([{ kind: 'imageUrl', url }], {
          cwd, allowRemoteImages: true, resolveHostname: async () => ['93.184.216.34'],
        }),
        /Remote image URL is invalid/,
        label,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// skill 要按 name **和** path 双重匹配。只比其中一个的话，同名不同路径的技能会被
// 当成已启用的那个——加载到的是另一个文件。
test('skill 必须 name 与 path 同时匹配已启用的那一个', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-input-skill-')));
  const skillEntries = [{ skills: [{ name: 'deploy', path: '/skills/a/deploy.md', enabled: true }] }];
  try {
    const ok = await resolveInputParts(
      [{ kind: 'skill', name: 'deploy', path: '/skills/a/deploy.md' }], { cwd, skillEntries },
    );
    assert.deepEqual(ok, [{ kind: 'skill', name: 'deploy', path: '/skills/a/deploy.md' }]);

    for (const [label, part] of [
      ['同名不同路径', { kind: 'skill', name: 'deploy', path: '/skills/evil/deploy.md' }],
      ['同路径不同名', { kind: 'skill', name: 'other', path: '/skills/a/deploy.md' }],
    ]) {
      await assert.rejects(
        () => resolveInputParts([part], { cwd, skillEntries }),
        /not enabled/,
        `${label}：不能算作匹配`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
