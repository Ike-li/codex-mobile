import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

function resolveCandidate(raw, baseDir) {
  if (!raw) return raw;
  return isAbsolute(raw) ? raw : join(baseDir, raw);
}

export function parseWorkdirSources(raw, {
  baseDir = process.cwd(),
  readFileSync: readFile = readFileSync,
  statSync: stat = statSync,
} = {}) {
  const text = String(raw || '').trim();
  if (!text) return { paths: [], warnings: [] };

  const candidate = resolveCandidate(text, baseDir);
  try {
    const info = stat(candidate);
    if (info.isFile()) {
      const parsed = JSON.parse(readFile(candidate, 'utf8'));
      if (!Array.isArray(parsed)) {
        return { paths: [], warnings: [`WORK_DIRS JSON 不是数组：${text}`] };
      }
      const paths = [];
      const warnings = [];
      for (const entry of parsed) {
        if (typeof entry === 'string' && entry.trim()) {
          paths.push(entry.trim());
          continue;
        }
        if (entry && typeof entry.path === 'string' && entry.path.trim()) {
          paths.push(entry.path.trim());
          continue;
        }
        warnings.push(`WORK_DIRS 忽略无效条目：${JSON.stringify(entry)}`);
      }
      return { paths, warnings };
    }
  } catch (err) {
    if (existsSync(candidate) || /\.json$/i.test(text)) {
      return { paths: [], warnings: [`WORK_DIRS 无法读取 ${text}：${err.message}`] };
    }
  }

  return {
    paths: text.split(',').map(item => item.trim()).filter(Boolean),
    warnings: [],
  };
}

export function resolveWorkdirAllowlist({
  workDir,
  extra = '',
  baseDir = process.cwd(),
  realpathSync: realpath = realpathSync,
  statSync: stat = statSync,
  readFileSync: readFile = readFileSync,
} = {}) {
  const warnings = [];
  let primary;
  try {
    if (!stat(workDir).isDirectory()) throw new Error(`WORK_DIR 不是目录：${workDir}`);
    primary = realpath(workDir);
  } catch (err) {
    throw new Error(err.message.includes('WORK_DIR') ? err.message : `WORK_DIR 不存在：${workDir}（请在 .env 中设置有效路径）`);
  }

  const workDirs = [primary];
  const parsed = parseWorkdirSources(extra, { baseDir, readFileSync: readFile, statSync: stat });
  warnings.push(...parsed.warnings);
  for (const raw of parsed.paths) {
    try {
      const resolved = realpath(raw);
      if (!stat(resolved).isDirectory()) {
        warnings.push(`WORK_DIRS 忽略（不是目录）：${raw}`);
        continue;
      }
      if (!workDirs.includes(resolved)) workDirs.push(resolved);
    } catch {
      warnings.push(`WORK_DIRS 忽略（不存在/不可达）：${raw}`);
    }
  }
  return { workDir: primary, workDirs, warnings };
}

// app-server 的 fs/* 只校验「是不是绝对路径」——它假定 client 与自己同机、物理接触即可信。
// 我们的 client 是远程手机，那个假定不成立，作用域只能由这一侧兜住。
//
// 目的是防误操作，不是防攻击者：能发消息的设备照样可以让 agent 去读同一个文件。它挡住的
// 是「随手翻文件翻到 ~/.ssh/id_rsa」，以及把工作区外的凭据挡在默认视野之外——凭据外泄是
// 唯一撤销设备也收不回的破坏。
//
// 返回 realpath 归一后的绝对路径；不在任何工作区内时返回 null。
export function resolveWithinWorkdirs(rawPath, workDirs = [], {
  realpathSync: realpath = realpathSync,
} = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  if (!isAbsolute(rawPath)) return null;
  if (!Array.isArray(workDirs) || workDirs.length === 0) return null;

  // 目标可以尚不存在（新建文件），此时对最近的已存在祖先做 realpath，再把不存在的尾巴接
  // 回去。不存在的组件不可能是软链接，所以拼回去不会重新打开逃逸口。
  let probe = resolve(rawPath);
  const tail = [];
  for (;;) {
    try {
      probe = realpath(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return null;
      tail.unshift(basename(probe));
      probe = parent;
    }
  }
  const resolved = tail.length ? join(probe, ...tail) : probe;

  // 必须比到分隔符：只用 startsWith 的话 /srv/work 会顺带放行 /srv/work-other。
  for (const dir of workDirs) {
    if (resolved === dir || resolved.startsWith(dir + sep)) return resolved;
  }
  return null;
}

/**
 * WORKDIRS 数组 → 允许列表。codex.config.json 走这条路。
 *
 * 与 resolveWorkdirAllowlist 的分工：那个入口是 .env 时代的形态（WORK_DIR 主目录 +
 * WORK_DIRS 附加源，后者还是「文件路径或逗号串」的双形态），保留是为了兼容；
 * 这个入口只认一个数组，**首项就是主工作目录**。
 *
 * 不把数组 join(',') 再喂回旧入口：含逗号的目录名会被重新拆坏，而拆坏之后
 * 看起来仍像是配好了。
 */
export function resolveWorkdirsFromEntries({
  entries = [],
  realpathSync: realpath = realpathSync,
  statSync: stat = statSync,
} = {}) {
  const warnings = [];
  const workDirs = [];

  for (const entry of entries) {
    const raw = typeof entry === 'string' ? entry : entry?.path;
    if (!raw) {
      warnings.push(`工作区条目无法识别，已跳过：${JSON.stringify(entry)}`);
      continue;
    }
    if (!isAbsolute(raw)) {
      throw new Error(`工作区必须是绝对路径：${raw}。`
        + '相对路径会让允许列表取决于进程从哪个目录启动，而那是权限边界不该依赖的东西。');
    }
    try {
      if (!stat(raw).isDirectory()) throw new Error('不是目录');
      const real = realpath(raw);
      if (!workDirs.includes(real)) workDirs.push(real);
    } catch (err) {
      warnings.push(`工作区不可用，已跳过：${raw}（${err.message}）`);
    }
  }

  if (workDirs.length === 0) {
    // fail-loud：空白名单的后果不是「没有工作区」，是范围判定失去参照。
    throw new Error('没有任何可用的工作区。检查 WORKDIRS 里的路径是否存在且是目录。');
  }
  return { workDir: workDirs[0], workDirs, warnings };
}
