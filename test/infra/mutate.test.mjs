// test/infra/mutate.test.mjs —— 守护变异测试的隔离前提。
// 守护：TEST-01（测试不得以真实 HOME / 生产数据目录为删除或写入目标）
// 测什么：容器闸真的会挡住宿主机运行；容器配置的三个隔离要素没被改掉。
// 不测什么 + 为什么：不测变异算子生成得对不对——那是 mutate.js 的产出质量，
//   由它自己的输出验证；这里守的是「跑错地方会不会毁掉这台机器」。
//
// 为什么这个文件必须存在：变异会故意改坏源码，而改坏的可能恰恰是算删除路径的代码。
// 姊妹项目就是这么删掉一整棵 ~/.claude/projects 的——变异把 getProjectDir 改成恒返回 ''，
// join(真实根, '') 塌成真实根本身，测试的 rmSync 打上去了。挡住它的是一次性 HOME，
// 不是代码里的护栏，所以这里守的是「一次性 HOME 还在不在」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, rel), 'utf8');

// 这一条断言的是**行为**不是文本：真的去跑一次，看它拒不拒绝。
// 扫源码只能证明「有一段 if」，证明不了那段 if 会生效。
test('容器闸：没有 CCM_IN_CONTAINER 时 mutate 拒绝运行', () => {
  const env = { ...process.env };
  delete env.CCM_IN_CONTAINER;

  const run = spawnSync(process.execPath, ['scripts/mutate.js', 'sanitizer.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    timeout: 15000,
  });

  assert.equal(run.status, 2,
    '缺 CCM_IN_CONTAINER 时必须以退出码 2 拒绝。它现在的退出码是 '
    + `${run.status}——如果是 0，说明变异正在宿主机的真实 HOME 上跑。\n`
    + (run.stdout || '') + (run.stderr || ''));

  assert.match(run.stderr, /拒绝运行/,
    '拒绝时要说明原因和替代命令，否则下一个人会以为脚本坏了并绕过它');
});

test('容器闸在设置了 CCM_IN_CONTAINER 后才放行到下一步', () => {
  // 只验证它越过了容器闸（不再是退出码 2），不真跑变异——那要几分钟。
  // 给一个不存在的文件，期望它落到「找不到文件」的 1，而不是容器闸的 2。
  const run = spawnSync(process.execPath, ['scripts/mutate.js', 'no-such-file.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CCM_IN_CONTAINER: '1' },
    timeout: 15000,
  });

  assert.equal(run.status, 1,
    '设了 CCM_IN_CONTAINER 后应当越过容器闸，落到「找不到文件」的退出码 1');
});

// 下面三条是形态闸：容器配置里那几个隔离要素被删掉时要变红。
// 它们守的是「隔离还在不在」，不是「配置写得好不好看」。

test('容器有一次性 HOME —— 这是整个 Dockerfile 存在的理由', () => {
  const dockerfile = read('docker/Dockerfile.test');
  assert.match(dockerfile, /ENV HOME=\/home\/ccm-test/,
    'HOME 必须指向容器内的一次性目录。少了这行，~/.codex 会解析到挂载进来的宿主机家目录，'
    + '容器就退化成一层没有隔离作用的包装');
});

test('变异 service 用只读挂载，改坏的源码到不了宿主机', () => {
  const compose = read('docker/docker-compose.test.yml');
  const mutateSection = compose.slice(compose.indexOf('mutate:'));

  assert.match(mutateSection, /\.\.:\/repo:ro/,
    'mutate service 必须只读挂载源码（`..:/repo:ro`）。改成读写的话，容器被 kill 或变异'
    + '中断时，改坏的源码会残留在宿主机上——而「靠 mutate.js 的恢复逻辑」又回到了'
    + '「安全性依赖代码正确性」，那正是变异要怀疑的东西');

  assert.doesNotMatch(mutateSection, /^\s+- \.\.:\/app\s*$/m,
    'mutate service 不得把源码读写挂到 /app');
});

test('Playwright 镜像 tag 与 package.json 的版本对齐', () => {
  const dockerfile = read('docker/Dockerfile.test');
  const pkg = JSON.parse(read('package.json'));
  const declared = pkg.devDependencies['@playwright/test'].replace(/^[\^~]/, '');
  const tag = /playwright:v([\d.]+)-/.exec(dockerfile);

  assert.ok(tag, 'Dockerfile 必须钉住 Playwright 镜像的具体版本');
  assert.equal(tag[1], declared,
    `镜像 tag v${tag[1]} 与 package.json 声明的 ${declared} 不一致。`
    + '版本错开时 Playwright 会报 "Executable doesn\'t exist"，而那句报错读起来'
    + '像是浏览器没装，不像是版本不匹配——升级 @playwright/test 时要同步改 Dockerfile');
});

// 第四条形态闸，来自一次实际踩坑：镜像里烧死过 `ENV CODEX_BIN=/app/scripts/mock-codex.sh`，
// 而 mutate service 的工作副本在 /work，那个路径在它里面根本不存在（/app 只有 node_modules）。
//
// 它没有立刻爆掉，因为需要 codex 的测试基本都自己造 fake（server-integration.test.mjs:3909
// 就覆写了 CODEX_BIN），所以基线一直是绿的。危险在于**下一条不自己造 fake 的测试**：
// 它在 test service 绿、在 mutate service 红，而变异会把那个红读成「这个变异被杀掉了」。
// 那是一个假红——正好是变异测试要消灭的东西的镜像，而且比假绿更难发现，因为分数变好看了。
//
// 所以守的不是「有没有写 CODEX_BIN」，而是**它和本 service 的 working_dir 是不是同根**。
function composeServices() {
  const compose = read('docker/docker-compose.test.yml');
  const body = compose.slice(compose.indexOf('\nservices:') + 1);
  const heads = [...body.matchAll(/^ {2}([a-z][\w-]*):$/gm)];
  return Object.fromEntries(heads.map((head, i) => [
    head[1],
    body.slice(head.index, i + 1 < heads.length ? heads[i + 1].index : body.length),
  ]));
}

test('每个 compose service 的 CODEX_BIN 都落在自己的 working_dir 下', () => {
  const services = composeServices();
  assert.ok(Object.keys(services).length >= 2,
    `compose 里应当至少有 test 与 mutate 两个 service，实际解析出 ${Object.keys(services)}`);

  for (const [name, section] of Object.entries(services)) {
    const workdir = /^\s+working_dir:\s*(\S+)/m.exec(section)?.[1];
    const codexBin = /^\s+CODEX_BIN:\s*(\S+)/m.exec(section)?.[1];

    assert.ok(workdir, `service ${name} 必须显式声明 working_dir，否则下面这条判据无从判断`);
    assert.ok(codexBin,
      `service ${name} 必须自己声明 CODEX_BIN。放回镜像里等于让两个 service 共用一个绝对路径，`
      + '而它们的工作副本不在同一个地方');
    assert.ok(codexBin.startsWith(`${workdir}/`),
      `service ${name} 的 CODEX_BIN=${codexBin} 不在它的 working_dir=${workdir} 下。`
      + '指向别的 service 的路径时，需要 codex 的测试会在这里挂起或 ENOENT，'
      + '而变异会把那个失败读成「变异被杀掉」——分数变好看了，实际什么都没测到');
  }
});

test('Dockerfile 不再烧死 CODEX_BIN，避免两个 service 抢同一个绝对路径', () => {
  assert.doesNotMatch(read('docker/Dockerfile.test'), /^ENV CODEX_BIN=/m,
    'CODEX_BIN 要留在 compose 的各 service 里声明（那里才知道 working_dir 是什么）。'
    + '镜像层只有一份 ENV，给谁都是错的');
});
