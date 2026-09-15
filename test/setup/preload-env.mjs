// test/setup/preload-env.mjs —— 单测的落盘隔离层，经 `node --import` 在任何测试文件之前加载。
//
// 【为什么必须是 --import，而不是在测试文件里设环境变量】
// ESM 的静态 import 在**模块链接阶段**求值，早于该文件自身任何顶层语句执行。哪怕把
// `process.env.CODEX_DATA_DIR = ...` 写在 import 语句上面，被 import 的模块也已经跑完
// 自己的顶层代码、锁定了落盘路径。本仓的具体靶子全是模块级常量：
//   · server.js 的 DATA_DIR
//   · server.js 的 SECURITY_AUDIT_FILE / HOST_CONFIG_AUDIT_FILE
//   · server.js 的 PUSH_SUB_FILE
//   · devices.js 的 dataDir()
// 只有预加载能跑在它们之前。
//
// 【为什么连 TMPDIR 一起收】
// 多数测试文件**已经**有 before/after 的 rmSync 却照样漏：被测模块的异步/防抖落盘发生在
// after **之后**，它的 mkdirSync(recursive) 会把刚删掉的目录重新建出来。逐个去找 flush API
// 只能一次修一个，而下一个引入防抖写的模块又会漏。把 TMPDIR 整个收进一次性根之后，所有
// 测试文件自己的 mkdtemp 也落在它下面，漏掉的那次重建同样被一并清掉。
//
// 【这里不设还没有消费者的变量】
// CODEX_READ_STATE_FILE / CODEX_UPLOAD_ROOT / CODEX_APPROVAL_AUDIT_FILE 要等对应功能落地
// （见计划 B5/B7）再加。现在就写等于放一个永远为真的隔离承诺——看起来隔离了，其实没有。
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'ccm-test-data-'));

const scratch = join(root, 'tmp');
const data = join(root, 'data');
mkdirSync(scratch, { recursive: true });
mkdirSync(data, { recursive: true });

process.env.TMPDIR = scratch;
process.env.CODEX_DATA_DIR = data;

// 【这里刻意不设 CODEX_RPC_LOG='0'】实测确认过：所有碰 RPC 日志的用例都显式传
// rpcLogPath 指向自己的 mkdtemp 目录（agent-appserver-branches.test.mjs:89 等），
// 不会落到仓库根。而 agent-appserver.js:80 的判据是 `CODEX_RPC_LOG === '0' ? null : ...`
// —— 环境变量**压过**显式路径，在这里关掉会让那 10 条用例全部失去被测对象。
// 仓库根那份 .codex-chat-rpc.jsonl 来自真实 server 运行，不是测试产生的。

// 'exit' 而不是 SIGINT/SIGTERM：它对正常结束与 process.exit() 都触发，且只允许同步操作
// —— rmSync 正好是同步的。不清理的代价是 /tmp 里单调堆积一次性目录（姊妹仓实测攒到过 9781 个）。
process.on('exit', () => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不该让测试变红 */ }
});
