// scripts/gates/check-test-summary.js —— 跑测试，并在 cancelled / skipped 不为 0 时让构建变红。
//
// 为什么需要它：`node --test` 的汇总把 cancelled 和 skipped 与 fail 分开计数，而**退出码
// 不一定反映它们**。于是一次「fail 0」的运行可能实际上有整片用例根本没跑——症状是全绿，
// 是最贵的失败模式。
//
// 这不是假想：`app-server-transport.test.mjs` 的 4 个用例曾在每一次运行里被标记 cancelled
// （请求超时定时器是 unref 的，测试等它时事件循环已排空，node --test 判定「promise 仍挂起
// 而事件循环已结束」，把该用例连同其后三个一并取消）。超时、子进程退出、子进程错误和
// dispose 四条错误路径因此长期未被验证，而汇总显示 fail 0。
//
// 那个具体问题已经修了（实测 13 pass / 0 cancelled），**但没有任何机制防止它复发**。
// 这个脚本就是那道防线。
//
// 用法：node scripts/gates/check-test-summary.js [传给 node --test 的参数...]

import { spawn } from 'node:child_process';

/**
 * 从 `node --test` 的输出里判断这次运行能不能算通过。
 *
 * 导出为纯函数，测试直接 import 真的——不手写 stub（否则验证的是 stub 不是实现）。
 *
 * @param {string} output 测试运行的完整 stdout
 * @returns {{ok: boolean, reason?: string, counts?: Record<string, number>}}
 */
export function summaryVerdict(output) {
  // 汇总行形如 `ℹ cancelled 0`。要求整行只有「符号 + 关键字 + 数字」，
  // 免得把测试名里出现的这些词当成汇总（本仓的测试注释里就提到过 cancelled）。
  const pick = key => {
    const re = new RegExp(`^[^\\w\\n]*${key}\\s+(\\d+)\\s*$`, 'm');
    const m = re.exec(output);
    return m ? Number(m[1]) : null;
  };

  const counts = {
    tests: pick('tests'),
    pass: pick('pass'),
    fail: pick('fail'),
    cancelled: pick('cancelled'),
    skipped: pick('skipped'),
  };

  // 解析不到汇总就当失败。fail-closed：报告格式变了而我们读不懂时，
  // 沉默地放行等于把这道门拆了。
  if (counts.cancelled === null || counts.skipped === null) {
    return { ok: false, reason: '读不到测试汇总行（cancelled / skipped）。报告格式变了？', counts };
  }

  if (counts.cancelled > 0) {
    return {
      ok: false,
      counts,
      reason: `cancelled ${counts.cancelled} —— 这些用例没跑，不是跑过了。\n`
        + 'node --test 不把 cancelled 计进 fail，所以汇总看起来是通过的。常见成因：\n'
        + '  · 用例 await 一个 unref 的定时器，事件循环先排空了\n'
        + '  · 前一个用例被取消，其后的用例被连带取消\n'
        + '找到挂起的那个 promise，别把这个数字放过去。',
    };
  }

  if (counts.skipped > 0) {
    return {
      ok: false,
      counts,
      reason: `skipped ${counts.skipped} —— 跳过的用例不提供任何保护。\n`
        + '如果跳过是有意的，删掉那条用例并在 commit 里说明为什么不需要它；\n'
        + '留一条永远不跑的用例，只是让覆盖看起来比实际多。',
    };
  }

  return { ok: true, counts };
}

// ---- CLI ----

// import 本模块时不执行（测试要 import 纯函数）。
if (process.argv[1] && process.argv[1].endsWith('check-test-summary.js')) {
  const args = process.argv.slice(2);
  const child = spawn(process.execPath, ['--test', ...args], {
    stdio: ['inherit', 'pipe', 'inherit'],
  });

  let captured = '';
  child.stdout.on('data', chunk => {
    process.stdout.write(chunk);      // 实时转发，别让人对着 66 秒的空屏幕等
    captured += chunk;
  });

  child.on('close', code => {
    const verdict = summaryVerdict(captured);
    if (!verdict.ok) {
      console.error(`\n❌ ${verdict.reason}\n`);
      process.exit(code === 0 ? 1 : code);
    }
    process.exit(code);
  });
}
