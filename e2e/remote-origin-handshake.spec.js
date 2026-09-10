// 远程浏览器能不能连上网关。
//
// 这是本产品的主用途（手机连开发机），却一直没有任何测试覆盖，因为整套 E2E 都跑在
// loopback 上 —— 而 loopback 恰好走的是 evaluateSocketHandshakeSecurity 里**另一条**分支。
// 实跑远程设备接入验收时才发现：远程端的 socket 握手一律 403
// origin_required，页面停在断线横幅，永远到不了设备配对画面。
//
// 成因是三件事叠加，单看每一件都正常：
//   1. socket.io 默认先试 polling，失败才升级 websocket；
//   2. 浏览器对**同源** XHR 不发 Origin 头（跨源才发）；
//   3. 服务端对 remote 连接强制要求 Origin。
// 而真实远程部署（Tailscale Serve / cloudflared / HTTPS 反代）里，页面和 socket 永远同源。
// 于是 CODEX_ALLOWED_ORIGINS 白名单根本没机会被查 —— 它匹配的那个头压根没送来。
//
// 不需要局域网：isLocalAccess 要求 remoteAddress 和 Host 头**都**是 loopback，所以把
// 浏览器指到一个解析回 127.0.0.1 的非 loopback 主机名，就能走到远程那条分支。
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3401;
const HOSTNAME = 'gateway.test';
const ORIGIN = `http://${HOSTNAME}:${PORT}`;
// 一次性的本地凭据，随进程消失；不是任何真实部署的口令。
const TOKEN = 'e2e-remote-origin-handshake-token-0001';

test.use({ launchOptions: { args: [`--host-resolver-rules=MAP ${HOSTNAME} 127.0.0.1`] } });

let server;

test.beforeAll(async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'ccm-remote-'));
  const dataDir = join(workDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'trusted-devices.json'), '[]');
  writeFileSync(join(dataDir, 'pending-devices.json'), '[]');
  writeFileSync(join(workDir, 'README.md'), 'remote origin handshake\n');

  server = spawn(process.execPath, [join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      // 后端仍是 mock：这条用例验的是网关的握手闸，不消耗任何模型额度。
      CODEX_BIN: join(ROOT, 'scripts/mock-codex.sh'),
      PORT: String(PORT),
      HOST: '127.0.0.1',
      WORK_DIR: workDir,
      WORK_DIRS: workDir,
      CODEX_DATA_DIR: dataDir,
      CODEX_SANDBOX: 'read-only',
      CODEX_APPROVAL_POLICY: 'on-request',
      AUTH_TOKEN: TOKEN,
      // 本机验收专用，等价于自愿放弃传输层加密；真实部署必须保持 0。
      CODEX_ALLOW_INSECURE_REMOTE: '1',
      CODEX_ALLOWED_ORIGINS: ORIGIN,
    },
    stdio: 'ignore',
  });

  // 判「在听」而不是判「200」：设了 AUTH_TOKEN 之后 /health 本身要鉴权，会回 401。
  // 拿 .ok 当就绪条件会一直等到超时，而服务其实早就起来了。
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/health`);
      return;
    } catch { /* 还没开始监听 */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('远程握手用的网关没能在 18 秒内起来');
});

test.afterAll(() => server?.kill());

test('一台远程设备能连上网关并停在设备配对画面', async ({ page }) => {
  const rejections = [];
  page.on('response', async response => {
    if (!response.url().includes('socket.io/?')) return;
    if (response.status() < 400) return;
    rejections.push(`${response.status()} ${(await response.text().catch(() => '')).slice(0, 60)}`);
  });

  await page.goto(ORIGIN);
  await page.locator('#auth-token-input').fill(TOKEN);
  await page.locator('#auth-submit').click();

  // 判据是用户看得见的画面：整屏的「等待设备授权」，而不是断线横幅。
  // 不能把 rejections 拼进 expect 的 message —— 那个字符串在**调用时**就求值了，
  // 那会儿一次重试都还没发生，失败信息永远是空的。等断言真的失败了再去读。
  try {
    await expect(page.locator('#device-auth')).toBeVisible({ timeout: 20000 });
  } catch (err) {
    throw new Error(
      `远程设备没能连上网关，停在了断线画面。socket 握手被拒：`
      + `${rejections.join(' / ') || '(没抓到 4xx，病因在别处)'}\n${err.message}`,
    );
  }

  // 待批设备必须看到自己的设备号，否则用户无从批准。
  await expect(page.locator('#device-id-display')).not.toBeEmpty();

  expect(rejections, 'socket 握手不应当出现 4xx').toEqual([]);
});

// 远程设备的完整信任生命周期。
//
// 这两条此前被同一个错误理由（「需第二台真机」）挡了两轮，从没执行过。补跑 VC-A02 时
// 撞出了上面那个握手缺陷；补跑 VC-H05 时又撞出「非 secure context 下发消息静默失败」。
// 所以这里把整条链路固化下来：等待 → 隔离 → 批准 → 可用 → 撤销 → 立即失效。
//
// ⚠️ 关于「B 看不到 A 的消息内容」这条断言的**真实强度**，别高估：
// 写的时候我以为它是服务端那五处 `deviceApproved !== true` 广播闸的肉眼版本。实测不是。
// 把 on() 的总闸整段拆掉（未授权设备的事件不再被丢弃），这条断言**照样绿**——因为消息
// 内容走的是 io.to(instanceRoom).emit 这条 room 通路，而 B 之所以收不到，是它的客户端在
// 等待画面下压根没去请求加入 room，不是服务端拒绝了它。
//
// 所以这条断言守的是**用户屏幕上的最终结果**（未批准的设备不该看到会话内容），
// 服务端那五处闸由 test/server-security.test.mjs:375 的静态绊线守着。两者不可互相替代，
// 也不要在报告里把这条算成「广播闸已验证」。
//
// 记在这里是因为这轮反复吃同一个亏：**一条只覆盖一半形态的绊线比没有更危险，
// 因为它让人以为查过了。** 这次差点由我自己再犯一遍。
test('远程设备的信任生命周期：批准前隔离、批准后可用、撤销后立即失效', async ({ browser }) => {
  const context = await browser.newContext();
  const A = await context.newPage();   // loopback，受信任
  const B = await context.newPage();   // 远程 origin，待批
  // localStorage 按 origin 隔离，两个 origin 天然是两台设备，不需要第二个浏览器配置。

  // 判「用户看得见」而不是「在布局里」：#device-auth 是全屏遮罩，
  // 而 isVisible() 不看遮挡，用它会得到恒真的空断言。
  const clickableToUser = async (page, selector) => page.evaluate(sel => {
    const el = globalThis.document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const hit = globalThis.document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (el === hit || el.contains(hit));
  }, selector);

  const signIn = async (page, origin) => {
    await page.goto(origin);
    await page.locator('#auth-token-input').fill(TOKEN);
    await page.locator('#auth-submit').click();
  };

  try {
    await signIn(A, `http://127.0.0.1:${PORT}`);
    await expect(A.locator('#msg-input')).toBeVisible({ timeout: 20000 });

    await signIn(B, ORIGIN);
    await expect(B.locator('#device-auth'), 'B 应当停在设备配对等待画面').toBeVisible({ timeout: 20000 });
    await expect(B.locator('#device-id-display'), 'B 必须看到自己的设备号，否则无从批准').not.toBeEmpty();

    // 隔离：A 发一条消息，B 一个字都不该收到。
    const secret = `ISOLATION-${Date.now()}`;
    await A.locator('#msg-input').click();
    await A.keyboard.type(secret);
    await A.keyboard.press('Enter');
    await expect.poll(
      () => A.evaluate(m => (globalThis.document.getElementById('messages')?.textContent || '').includes(m), secret),
      { message: 'A 自己都没发出去，隔离断言会变得没有意义', timeout: 20000 },
    ).toBe(true);

    expect(
      await B.evaluate(() => globalThis.document.body.textContent || ''),
      '未批准的设备看到了另一端的消息内容 —— 广播闸失效',
    ).not.toContain(secret);

    // 批准：B 自动进入，无需刷新。
    const navigations = [];
    B.on('framenavigated', frame => { if (frame === B.mainFrame()) navigations.push(frame.url()); });

    await A.locator('#pending-panel .approve-btn[data-id]').first().click();
    await expect
      .poll(() => clickableToUser(B, '#msg-input'), { message: '批准后 B 的输入框仍不可点', timeout: 20000 })
      .toBe(true);

    // 批准后必须真的能用。此前这里是静默失败：非 secure context 下 crypto.randomUUID
    // 不存在，发送路径抛 TypeError，文字留在输入框，状态还显示 idle。
    const mine = `FROM-B-${Date.now()}`;
    await B.locator('#msg-input').click();
    await B.keyboard.type(mine);
    await B.keyboard.press('Enter');
    await expect.poll(
      () => B.evaluate(m => (globalThis.document.getElementById('messages')?.textContent || '').includes(m), mine),
      { message: '已批准的远程设备发不出消息', timeout: 20000 },
    ).toBe(true);

    // 撤销：立即失效，不是等到下次刷新。
    await A.locator('#menu-btn').click();
    await A.locator('#native-devices-btn').click();
    const revoke = A.locator('#native-panel [data-revoke-device]');
    await expect(revoke.first(), 'A 的设备面板里应当能看到 B').toBeVisible({ timeout: 20000 });
    await revoke.first().click();
    await expect(A.locator('#confirm-modal'), '撤销不可逆，必须二次确认').not.toHaveAttribute('hidden', '');
    await A.locator('#confirm-ok').click();

    await expect
      .poll(() => clickableToUser(B, '#msg-input'), { message: '撤销后 B 仍能操作 —— 撤销有窗口期', timeout: 20000 })
      .toBe(false);
    expect(navigations, '失效必须是即时的，不能靠 B 自己刷新').toEqual([]);
  } finally {
    await context.close();
  }
});
