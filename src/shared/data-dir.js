// src/shared/data-dir.js —— 部署状态根（data/）的唯一解析点。
//
// 【env 必须在函数体内读，不能提到模块顶层】
// 这是本文件唯一一条承重规则。静态 import 在**模块链接阶段**求值，早于任何 import 它的
// 文件的顶层语句——也就是早于 server.js 的 `dotenv.config()`。把 CODEX_DATA_DIR 读成模块级
// 常量的话，.env 里的那一行就永远读不到，状态目录静默回落到仓库里的 data/，而**没有任何
// 报错**：server 正常起、设备能批、审计照写，只是全写错了地方。写成函数就没有这个时序问题。
//
// 【PROJECT_ROOT 上溯两层】
// 本文件住在 src/shared/，距仓库根两层。少写一层会让 data/ 解析到 src/data/ —— 同样不报错，
// 同样只是安静地换了个地方写。两条都由 test/unit/data-dir.test.mjs 钉着。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 解析状态根。
 *
 * @param {Record<string, string|undefined>} env 可注入，默认 process.env
 * @returns {string} 绝对路径
 */
export function resolveDataDir(env = process.env) {
  // 空串按未设置处理：`export CODEX_DATA_DIR=` 是 shell 里很自然的「取消设置」写法，
  // 而空串一路传下去会让 join('', 'x') 塌成相对路径，落到进程 cwd —— 那取决于谁在哪里
  // 起的 server，是最难复现的一类问题。
  const override = env?.CODEX_DATA_DIR;
  return override ? override : join(PROJECT_ROOT, 'data');
}

/** 状态根下的某个文件。与 resolveDataDir 同样在调用时求值。 */
export function dataFile(name, env = process.env) {
  return join(resolveDataDir(env), name);
}
