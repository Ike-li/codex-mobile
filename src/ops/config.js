// src/ops/config.js —— 运行时配置的加载入口，替代 server.js 里直接调 dotenv.config()。
//
// 换掉 dotenv.config() 的理由不是 dotenv 不好用，是**加载点需要一个可注入、可单测的边界**：
// 之前配置从哪来、谁压过谁，只存在于 server.js 顶层那四行里，没有任何测试看得见；而
// doctor 要回答的恰恰是「它看到的 = server 启动时会看到的」，那要求两边共用同一个加载器。
//
// 【本阶段刻意保持行为一个字节不变】消费点仍然全部读 process.env，所以这里仍然把值
// 投影回去。把消费点迁成类型化读取是下一批的事，分开做才能拿到「新旧投影逐键相等」
// 这个证明——合成一批就只能靠肉眼比对 diff。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigSources, resolveConfigValues, projectToEnv } from './config-file.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * shell 来源快照：只答「这个 key 在 shell 里设没设」，**绝不回显值**。
 *
 * 用途是让配置面板与 doctor 能标出「这一行被环境变量压过了」。被压住的那个 key
 * 很可能正是 AUTH_TOKEN 或 VAPID 私钥，所以这里只出布尔。
 */
export function getShellEnvSnapshot(env = process.env) {
  const snapshot = {};
  for (const [key, value] of Object.entries(env)) {
    snapshot[key] = typeof value === 'string' && value !== '';
  }
  return snapshot;
}

/**
 * 读配置并投影进给定的 env 对象（默认 process.env），返回投影后的结果与元信息。
 *
 * @returns {{env: object, source: string, path: string|null, warnings: string[]}}
 */
export function applyRuntimeConfig({ dir = PROJECT_ROOT, env = process.env } = {}) {
  const { source, fileValues, path, warnings } = loadConfigSources({ dir });

  // dotenv 的「不覆盖已存在 key」语义在这里是显式的一行，而不是一个要靠记性的库行为。
  const shellEnv = { ...env };
  const values = resolveConfigValues({ fileValues, shellEnv });
  for (const [key, value] of Object.entries(values)) {
    const projected = projectToEnv(key, value);
    if (projected !== null) env[key] = projected;
  }

  // 【这段全局删空串是承重的，不是顺手的清理】
  // 具体陷阱：`export PORT=` 之后，删掉 → Number(undefined)=NaN → server.js 回落 3001；
  // 不删 → Number('')=0 → PORT 0 是**随机端口**，手机再也连不上原来那个地址。
  // 换血前它在 server.js 里没有注释，很容易被当成多余清理删掉，所以理由写在这里。
  //
  // 作用域目前仍是**整个 env**（与换血前逐字相同）。把它收窄到已登记的配置键是更干净的
  // 做法——不该因为本项目的一个约定去改与本项目无关的变量——但那是一次行为改变，
  // 留到消费点迁移那一批一起做，本批的价值全在「一个字节没变」上。
  for (const key of Object.keys(env)) {
    if (env[key] === '') delete env[key];
  }

  return { env, source, path, warnings };
}

let cached = null;

/** 记忆化入口：进程内只加载一次。测试用 applyRuntimeConfig 显式注入，不碰这个。 */
export function loadRuntimeConfig(options) {
  if (!cached) cached = applyRuntimeConfig(options);
  return cached;
}
