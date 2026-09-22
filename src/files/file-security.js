// file-security.js —— 文件安全守卫
// 功能：symlink 穿越防御 + owner-only 权限检查与修复。
// 用途：配置文件写入、doctor 权限检查、上传文件防护。
import { lstatSync, chmodSync, accessSync, constants, writeFileSync, openSync, closeSync, fsyncSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { platform } from 'node:os';

const isWindows = platform() === 'win32';

/**
 * 检查路径中是否包含可疑的 symlink（用户可写目录中的 symlink）
 * 返回可疑 symlink 路径，或 null（安全）
 */
export function rejectableSymlinkComponent(path) {
  let current = resolve(path);
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        const parent = dirname(current);
        try {
          accessSync(parent, constants.W_OK);
          return current;
        } catch {
          // 父目录不可写，symlink 相对安全
        }
      }
    } catch {
      // 路径组件不存在，继续向上
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * 检查文件权限是否为 owner-only (0600 文件 / 0700 目录)
 */
export function isOwnerOnly(path, isDir = false) {
  if (isWindows) return true;

  try {
    const stat = lstatSync(path);
    const mode = stat.mode & 0o777;
    const expected = isDir ? 0o700 : 0o600;
    return mode === expected;
  } catch {
    return false;
  }
}

/**
 * 修复文件权限为 owner-only
 */
export function fixPermissions(path, isDir = false) {
  if (isWindows) return true;

  const mode = isDir ? 0o700 : 0o600;
  try {
    chmodSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * 创建 owner-only 文件（0600 权限），真原子写。
 */
export function writeOwnerOnlyFile(path, content) {
  if (isWindows) {
    writeFileSync(path, content);
    return;
  }

  const tmp = `${path}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  renameSync(tmp, path);
  fixPermissions(path, false);
}

/**
 * 以 O_APPEND 追加 owner-only 文件，避免读取并重写已有内容。
 */
export function appendOwnerOnlyFile(path, content) {
  if (isWindows) {
    let fd;
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return;
  }

  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  fixPermissions(path, false);
}

/**
 * 检查路径列表的权限，返回有问题的路径
 */
export function checkPermissions(paths, isDir = false) {
  const problems = [];
  for (const path of paths) {
    try {
      if (!lstatSync(path)) continue;
    } catch {
      continue;
    }

    if (!isOwnerOnly(path, isDir)) {
      problems.push(path);
    }
  }
  return problems;
}

/**
 * 这个路径能不能安全地 open() 来读。
 *
 * 【为什么必须在 open 之前拦，而不是靠 open 的 flags】POSIX 下 `open(FIFO, O_RDONLY)`
 * 在没有 writer 的时候会**无限阻塞**——而本服务是单进程 Node，阻塞住的是整个事件循环：
 * 所有会话一起卡死，没有报错、没有超时、没有日志。`O_NOFOLLOW` 改变不了这一点（它管的是
 * 符号链接，不是文件类型），字符设备与 unix socket 同理。
 *
 * lstat 而不是 stat：不跟随符号链接。放行 symlink 本身是有意的——范围校验在别处做，
 * 这里只回答「open 它会不会把进程挂住」。
 *
 * @param {string} path 已经过范围校验的绝对路径
 */
export function isOpenableTarget(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;   // 看不到就不开，fail-closed
  }
}
