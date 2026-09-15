// test/invariants/public-shell-guard.test.mjs —— public/ 外壳的结构性绊线。
// 守护：SHELL-01
//
// 这个文件原名 public-ui.test.mjs，有 1807 行、90 个 test，其中 75 个是「切一段
// app.js 的源码文本，再正则断言它长什么样」：
//
//     assert.match(handler, /const target = await ensureViewTarget\(\)/);
//     assert.match(allContent, /let instanceSnapshotReceived = false/);
//
// 它们验证的是**代码长这个样子**，不是**代码做对了事**。把两个分支写反、把参数传错、
// 把返回值用错，全都照样绿；反过来重命名一个变量就红一片。三条实测的代价：
//
//   1. 1028–1401 与 1402–1775 是**逐字相同的 374 行**，15 个 test 跑了两遍
//      （fc2ad4a 那次重构粘重了）。879 个测试全绿，没有任何东西发现它 ——
//      文件大到没人能通读，就是它失去审阅价值的那一刻。
//   2. 两条断言互相打架而同时绿：一条要求源码里必须出现 `crypto.randomUUID()`，
//      另一条（下面还留着的那道绊线）禁止裸调它。前者会拦住「把 createDeviceToken
//      改用统一的 randomId()」这个明确的改进 —— 门禁在阻止修 bug。
//   3. 样式与布局断言在 e2e/ 里已有**真浏览器 getComputedStyle** 的版本
//      （semantic-color-tokens / pointer-affordances / markdown-typography /
//      header-layout / approval-card-style），文本 grep 是同一件事的弱化重复。
//
// 现在只留结构性绊线：不描述实现长什么样，只在越过一条边界时变红。
// UI 行为归 e2e/，可提取的纯逻辑归 public/js/ 下的模块 + 各自的真 import 单测。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PUBLIC_JS = new URL('../../public/js/', import.meta.url);
const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

/** 逐行扫描 public/js 下的所有脚本，返回命中 predicate 的 `文件:行号  内容`。 */
function scanClientSources(predicate) {
  const offenders = [];
  for (const name of readdirSync(PUBLIC_JS)) {
    if (!name.endsWith('.js')) continue;
    const source = readFileSync(new URL(name, PUBLIC_JS), 'utf8');
    source.split('\n').forEach((line, index) => {
      const trimmed = line.trim();
      // 注释里提到某个名字通常是在解释为什么不能用它，不是在用它。
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (predicate(line)) offenders.push(`${name}:${index + 1}  ${trimmed}`);
    });
  }
  return offenders;
}

test('外壳只加载外部脚本，没有内联 script', () => {
  // 无内联脚本是可以写进 CSP 的客观属性，不是代码风格。一旦破了，
  // script-src 就没法收紧到不含 'unsafe-inline'。
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, 'index.html 里一个 script 标签都没有，扫描器疑似失配');
  for (const [, attributes, body] of scripts) {
    assert.match(attributes, /\bsrc=/i, '出现了没有 src 的 script 标签');
    assert.equal(body.trim(), '', 'script 标签里出现了内联代码');
  }
});

test('外壳引用的每个样式表和脚本都能解析到 public/ 下的真实文件', () => {
  // 引用完整性零守护时，拆分资源（抽 CSS、拆模块）一旦写错路径，单测全绿而页面裸奔。
  const references = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel="stylesheet"/i.test(tag)) continue;
    references.push(tag.match(/\bhref="([^"]+)"/i)?.[1]);
  }
  for (const [, src] of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)) {
    references.push(src);
  }

  let checked = 0;
  for (const target of references) {
    assert.ok(target, '引用标签缺少 href/src');
    if (/^(?:https?:)?\/\//.test(target)) continue;
    // socket.io 客户端由 socket.io 中间件在运行时动态提供，public/ 下没有这个文件。
    if (target === '/socket.io/socket.io.js') continue;
    checked += 1;
    assert.ok(
      existsSync(new URL(`../../public${target}`, import.meta.url)),
      `index.html 引用了不存在的资源 ${target}`,
    );
  }
  assert.ok(checked >= 5, `资源扫描器失配——只检出 ${checked} 个本地引用`);
});

test('应用样式表排在 hljs 主题之后，覆盖关系不反转', () => {
  // app.css 覆盖了 .hljs 的代码块外观。顺序一旦提前，覆盖关系反转，代码块配色错乱。
  // 用引用顺序的索引断言，不用行号 —— 行号会随任何无关编辑漂移。
  const sheets = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi)]
    .map(([tag]) => tag.match(/\bhref="([^"]+)"/i)?.[1]);

  const appIdx = sheets.indexOf('/css/app.css');
  const darkIdx = sheets.indexOf('/vendor/github-dark.min.css');
  assert.ok(appIdx >= 0, 'public/css/app.css 必须被引用');
  assert.ok(darkIdx >= 0, 'hljs 主题样式表应仍被引用');
  assert.ok(appIdx > darkIdx, `app.css(#${appIdx})必须排在 github-dark(#${darkIdx})之后`);

  // 样式留在外部文件同样是可以写进 CSP 的属性（style-src 不需要 'unsafe-inline'）。
  assert.doesNotMatch(html, /<style>/, 'index.html 里出现了内联 <style> 块');
});

test('hljs 主题按配色互斥加载，且第三方登记与实际打包一致', () => {
  // 这条曾经断言「只打包暗色」。当时的理由成立：.codex .bubble.md pre 与 .tool-output
  // 硬编码 #1e1e1e 暗底，浅色下生效的 github 主题（深灰/深蓝前景）压在黑底上读不出来，
  // 于是删掉浅色那份、暗色不带 media。
  //
  // 但那是治标——根因是**背景不跟随主题**，而不是浅色主题有问题。现在底色走
  // --code-surface（浅 #ececec / 深 #1e1e1e），前景必须跟着切回来，两份都要打包。
  // 对比度由 e2e/code-surface.spec.js 按绝对判据守着，不靠这里。
  assert.match(html, /href="\/vendor\/github\.min\.css" media="\(prefers-color-scheme: light\)"/);
  assert.match(html, /href="\/vendor\/github-dark\.min\.css" media="\(prefers-color-scheme: dark\)"/);

  // 上面的引用完整性绊线只检查「被引用的文件存在」，不检查「文件都被引用」——
  // 删文件不会让它变红。这条反向断言同步第三方登记，属于许可证合规，不是风格。
  const notices = readFileSync(new URL('../../public/vendor/THIRD-PARTY-NOTICES.md', import.meta.url), 'utf8');
  for (const file of ['github.min.css', 'github-dark.min.css']) {
    assert.ok(
      existsSync(new URL(`../../public/vendor/${file}`, import.meta.url)),
      `${file} 被 index.html 引用，文件必须存在`,
    );
    assert.ok(notices.includes(file), `第三方登记里缺 ${file}`);
  }
});

test('客户端不得裸调 crypto.randomUUID —— 非 secure context 里它不存在', () => {
  // 后果不是报错，是**静默失败**：明文远程接入（CODEX_ALLOW_INSECURE_REMOTE=1，
  // 的本机远程验收路径）下 randomUUID 是 undefined，
  // 发消息抛 TypeError，文字留在输入框，状态还显示 idle，界面上没有任何提示。
  const offenders = scanClientSources(line => {
    if (!/\brandomUUID\b/.test(line)) return false;
    // 同一行上做了存在性检查就算有兜底：typeof x.randomUUID === 'function'、x?.randomUUID
    return !/typeof\s+[\w.?]*\.?randomUUID/.test(line) && !/\?\.randomUUID/.test(line);
  });

  assert.deepEqual(offenders, [],
    '这些地方裸调了 crypto.randomUUID，在非 secure context 下会抛 TypeError 并静默失败。'
    + '改成 import { randomId } from \'./random-id.js\'，或在同一行上加 typeof 检查：\n'
    + offenders.join('\n'));
});

test('客户端不得用 Math.random 生成凭证或请求 id', () => {
  // Math.random 不是密码学安全的：设备 token 和 clientRequestId 都用它去重/鉴权，
  // 可预测的值意味着设备可被冒充、请求 id 可被撞号。
  //
  // 这条以前的写法是 `assert.doesNotMatch(allContent, /deviceToken = 'dev_' \+ Math\.random/)`
  // —— 只盯着一个变量名的一种写法，换个名字就绕过去了。改成全目录扫描：
  // 边界是「不许出现」，而不是「那一行别长成那样」。
  const offenders = scanClientSources(line => {
    if (!/\bMath\.random\b/.test(line)) return false;
    // 抖动/退避这类非安全用途是正当的，要求显式标注，让每一次使用都被读到。
    return !/allow-math-random/.test(line);
  });

  assert.deepEqual(offenders, [],
    'Math.random 不是密码学安全的，不能用于凭证或请求 id。'
    + '改用 randomId()（public/js/random-id.js）；确属抖动/退避等非安全用途的，'
    + '在同一行加 `// allow-math-random: <理由>`：\n'
    + offenders.join('\n'));
});

test('Web 端不重新引入 ChatGPT 账号登录', () => {
  // 账号登录是有意移除的：本网关的信任模型是「设备配对 + AUTH_TOKEN」，
  // 在 Web 端再开一条账号登录通道会引入第二套身份，与 ARCHITECTURE.md 的威胁模型冲突。
  // 服务端推来的 account_* 事件仍要能渲染（Codex App 那边可能已登录），
  // 但**发起**登录的入口不该存在。
  const initiators = scanClientSources(line =>
    /account:loginStart|account:loginCancel|startChatgptDeviceLogin/.test(line));
  assert.deepEqual(initiators, [],
    'Web 端重新出现了发起 ChatGPT 登录的代码 —— 这会引入第二套身份，'
    + '与 ARCHITECTURE.md 的「设备配对 + AUTH_TOKEN」模型冲突：\n' + initiators.join('\n'));

  assert.doesNotMatch(html, /id="account-login-btn"|id="account-login-panel"/,
    'index.html 里重新出现了账号登录入口');
});
