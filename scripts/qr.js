// scripts/qr.js —— 把连接地址打成终端二维码，免手输 64 位令牌。
//
// 【为什么值得有】AUTH_TOKEN 是 64 位十六进制串，在手机上手输一次几乎必然出错，
// 而出错的表现是「令牌无效」——与令牌配错了长得一模一样。
//
// 【它含凭据，所以必须显式敲】不进启动横幅。横幅会出现在日志、截图、录屏里，
// 而一张带令牌的二维码等于把那台机器的访问权一并贴了出去。
//
// 【渲染必须是全块】姊妹项目 2026-09-09 真机实测：半块渲染（`▀` 单字符法与
// 「全黑/全白用 █ 和空格、仅混合格用 ▀▄」的四字符法）**两版都扫不出来**，同一个矩阵
// 改成全块立刻能扫。根因是一行文字承载两行模块做不到像素精确——终端行距会在模块之间
// 留下横缝，破坏扫码器的网格识别。代价是高度翻倍，但一张扫不出来的码高度再省也没用。
import { networkInterfaces } from 'node:os';
import { loadRuntimeConfig } from '../src/ops/config.js';
import { encodeQr } from '../src/shared/qrcode.js';
import { encodePng } from '../src/shared/png.js';

// 逐档实测过：quiet=2 检不出，3 和 4 可解——取标准值 4。
const QUIET = 4;
// 每个模块占 2 列。终端字符是高比宽的，1 列会把码压成 1:2 的竖条，扫不出来。
const CELL = 2;
const PNG_SCALE = 10;

/** 可达的局域网 IPv4。排除回环与 link-local——那两类地址手机连不上。 */
export function reachableIPv4s(interfaces = networkInterfaces()) {
  const found = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      if (entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;   // link-local，没有 DHCP 时的自配地址
      // 198.18/15 是 RFC 2544 的基准测试段，VPN 客户端（utun 之类）常拿它做虚拟接口。
      // 它会以「真实网卡」的身份出现在枚举里，但手机连不上——按接口名排除不行，
      // 名字各家不同；按**地址段**排除才稳。
      if (entry.address.startsWith('198.18.') || entry.address.startsWith('198.19.')) continue;
      found.push(entry.address);
    }
  }
  return found;
}

/**
 * 连接 URL。
 *
 * 【令牌走 query 而不是 hash】本仓前端读的是 `?token=`（public/js/app.js 的
 * URLSearchParams），进来之后立刻把它从地址栏擦掉。姊妹项目用的是 `#token=`——
 * 照搬那个形式会做出一张**扫得出但登不进**的码，而那种失败没有任何提示。
 */
export function buildConnectUrl({ host, port, token }) {
  const base = `http://${host}:${port}/`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/** 用 ANSI 背景色画。用前景色画方块的话，深色主题下会得到一张反色的码。 */
export function renderMatrix(matrix, size) {
  const dark = '\x1b[48;2;0;0;0m' + ' '.repeat(CELL) + '\x1b[0m';
  const light = '\x1b[48;2;255;255;255m' + ' '.repeat(CELL) + '\x1b[0m';
  const blankRow = light.repeat(size + QUIET * 2);

  const lines = [];
  for (let i = 0; i < QUIET; i += 1) lines.push(blankRow);
  for (let y = 0; y < size; y += 1) {
    let row = light.repeat(QUIET);
    for (let x = 0; x < size; x += 1) row += matrix[y][x] ? dark : light;
    lines.push(row + light.repeat(QUIET));
  }
  for (let i = 0; i < QUIET; i += 1) lines.push(blankRow);
  return lines.join('\n');
}

export function requiredColumns(size) {
  return (size + QUIET * 2) * CELL;
}

function main() {
  const asPng = process.argv.includes('--png-stdout');
  const { values } = loadRuntimeConfig();
  const token = values.AUTH_TOKEN || '';
  const port = values.PORT ?? 3001;
  const host = values.HOST || '127.0.0.1';

  // 说明与告警一律走 stderr：--png-stdout 的 stdout 必须只有图像字节。
  const say = line => process.stderr.write(`${line}\n`);

  let target = host;
  let alternatives = [];
  if (host === '0.0.0.0' || host === '::') {
    const addresses = reachableIPv4s();
    if (addresses.length === 0) {
      say('❌ 找不到可达的局域网地址。这台机器可能没连网络，或者只有回环接口。');
      process.exit(1);
    }
    [target, ...alternatives] = addresses;
  } else if (host === '127.0.0.1' || host === '::1' || host === 'localhost') {
    say('⚠️  当前只监听本机（HOST=127.0.0.1），手机扫了也连不上。');
    say('   要从手机连，把 HOST 改成 0.0.0.0，或在前面架一层反代 / 隧道。');
  }

  if (!token) {
    say('⚠️  没有设置 AUTH_TOKEN，二维码里不含令牌。');
  }

  const url = buildConnectUrl({ host: target, port, token });
  const qr = encodeQr(url);

  if (asPng) {
    // 刻意不调 process.exit()：stdout 接管道时是异步的，显式 exit 可能在 flush 之前
    // 退出，把图截断成半张——而半张 PNG 看起来就是「这个工具坏了」。
    process.stdout.write(encodePng(qr.matrix, { scale: PNG_SCALE, quiet: QUIET }));
    return;
  }

  const needed = requiredColumns(qr.size);
  const columns = process.stdout.columns ?? 0;
  if (columns > 0 && columns < needed) {
    // 不打一张必然扫不出来的码。宽度不够时字符会折行，整个网格就废了。
    say(`❌ 终端太窄：需要 ${needed} 列，当前 ${columns} 列。拉宽窗口后重试。`);
    process.exit(1);
  }

  say('');
  console.log(renderMatrix(qr.matrix, qr.size));
  say('');
  say(`   ${url}`);
  if (alternatives.length > 0) say(`   其他地址：${alternatives.join('、')}`);
  say('   ⚠️  这张码含访问令牌，扫到的人就能连上这台机器——别截图外发。');
  say('');
}

if (process.argv[1]?.endsWith('qr.js')) main();
