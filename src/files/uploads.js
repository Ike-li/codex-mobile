// uploads.js —— 附件校验与安全落盘。
// 手机选文件 → base64 → 写入 WORK_DIR/.ccm-uploads/ → 交给结构化 UserInput。
import { chmod, lstat, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve, basename, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { rejectableSymlinkComponent } from './file-security.js';

const UPLOAD_DIR = '.ccm-uploads';
const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 单文件 10MB
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;  // 总量 20MB
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const PNG_IEND = Buffer.from('0000000049454e44ae426082', 'hex');

/**
 * 按**内容**判断是不是图片，不看扩展名。
 *
 * 【为什么不能只认 PNG】识别不出来的后果不是报错：附件会以 mention 而不是 localImage
 * 下发，模型就"看不见"那张图，而界面上一切正常。iOS 截图确实是 PNG，但相册里的照片
 * 多是 JPEG——「从相册发一张图」是最常见的路径之一，只认 PNG 的话它一直是坏的。
 *
 * 【每种格式都同时查头和尾】只查魔数头会把截断的文件也判成图片，而截断的图片解不出来，
 * 失败会发生在更下游、错误信息更难懂。查尾等于顺带确认了「这个文件是完整的」。
 */
function detectImageMimeType(content) {
  // PNG：签名 + IHDR（宽高非零）+ IEND
  if (
    content.length >= 45
    && content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    && content.readUInt32BE(8) === 13
    && content.toString('ascii', 12, 16) === 'IHDR'
    && content.readUInt32BE(16) > 0
    && content.readUInt32BE(20) > 0
    && content.subarray(content.length - PNG_IEND.length).equals(PNG_IEND)
  ) {
    return 'image/png';
  }

  // JPEG：SOI(FFD8FF) 开头 + EOI(FFD9) 结尾
  if (
    content.length >= 4
    && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff
    && content[content.length - 2] === 0xff && content[content.length - 1] === 0xd9
  ) {
    return 'image/jpeg';
  }

  // GIF：GIF87a / GIF89a 开头 + trailer(0x3B) 结尾
  if (content.length >= 14) {
    const head = content.toString('ascii', 0, 6);
    if ((head === 'GIF87a' || head === 'GIF89a') && content[content.length - 1] === 0x3b) {
      return 'image/gif';
    }
  }

  // WebP：RIFF....WEBP。它是 RIFF 容器，长度写在头里——用那个字段核对实际长度，
  // 等价于其他格式的"查尾"。
  if (
    content.length >= 16
    && content.toString('ascii', 0, 4) === 'RIFF'
    && content.toString('ascii', 8, 12) === 'WEBP'
    && content.readUInt32LE(4) + 8 <= content.length
  ) {
    return 'image/webp';
  }

  return null;
}

function decodeBase64Strict(data) {
  if (typeof data !== 'string' || !data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const unpadded = data.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;
  if (data.includes('=') && data.length % 4 !== 0) return null;
  const decoded = Buffer.from(data, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== unpadded) return null;
  return decoded;
}

// 落盘名的长度预算。绝大多数文件系统的 NAME_MAX 是 255 字节，而实际写入的名字是
// `${Date.now()}-${8 位 hex}-${sanitizeName(...)}`，前缀占 23 个字符。留 32 的余量
// 给未来的前缀改动，仍远大于任何正常文件名。
const MAX_SAVED_NAME_LEN = 200;

// 文件名收敛：只取 basename，去路径分隔/控制/危险字符，去前导点，并限制长度。
//
// 长度必须在这里管：超长名字不是攻击，是很平常的情况（导出工具常把日期、查询串、
// 标题拼进文件名）。不收敛的话会一路走到 open() 才炸成 ENAMETOOLONG，用户拿到的是
// 一句裸 errno 加一段宿主机绝对路径，而不是「文件已上传」。
function sanitizeName(name) {
  // eslint-disable-next-line no-control-regex -- 过滤文件名中的控制字符属安全收敛
  const base = basename(String(name ?? '')).replace(/[\x00-\x1f\x7f]/g, '');
  // trim() **必须排在去前导点之前**。反过来的话，"<BOM>..evil" 在去点那一步看到的
  // 首字符是 BOM 而不是点，点原样留下，trim 再把 BOM 抹掉，结果是 "..evil" —— 一个
  // 隐藏文件；而同样意图的 "..evil" 直接传进来得到的是 "evil"。同一个意图的两个输入
  // 归一到不同结果，就说明顺序错了。BOM、NBSP 都算 JS trim 承认的空白，所以这条不是
  // 只针对普通空格。
  const safe = base.replace(/[/\\:*?"<>|]/g, '_').trim().replace(/^\.+/, '').trim();
  if (!safe) return 'file';
  if (safe.length <= MAX_SAVED_NAME_LEN) return safe;

  // 保住扩展名：agent 拿到的是这个名字，`.png` 被截掉会改变它对文件的判断。
  // 只认最后一个点之后的短后缀，避免把 "a.very.long.thing" 的中段当成扩展名。
  const dot = safe.lastIndexOf('.');
  const ext = dot > 0 && safe.length - dot <= 12 ? safe.slice(dot) : '';
  return safe.slice(0, MAX_SAVED_NAME_LEN - ext.length) + ext;
}

// 校验（零 IO）并交出解码后的 buffer 供复用。同一份 base64 此前会被解码三次——
// 校验、指纹、落盘各一次——每次都额外分配一个完整副本。
export function decodeAttachments(attachments) {
  if (attachments === undefined || attachments === null) return { decoded: [] };
  if (!Array.isArray(attachments)) return { error: '附件必须是数组' };
  if (attachments.length === 0) return { decoded: [] };
  if (attachments.length > MAX_FILES) {
    return { error: `附件过多（${attachments.length}，上限 ${MAX_FILES}）` };
  }
  const decoded = [];
  let total = 0;
  for (const a of attachments) {
    if (!a || typeof a.data !== 'string' || !a.data) return { error: '附件缺少数据' };
    if (typeof a.name !== 'string' || typeof a.mimeType !== 'string') {
      return { error: '附件缺少 name/mimeType' };
    }
    const content = decodeBase64Strict(a.data);
    if (!content) return { error: `附件「${a.name}」数据不是合法 base64` };
    if (content.length > MAX_FILE_BYTES) {
      return { error: `附件「${a.name}」过大（${(content.length / 1048576).toFixed(1)}MB，单文件上限 10MB）` };
    }
    total += content.length;
    decoded.push(content);
  }
  if (total > MAX_TOTAL_BYTES) {
    return { error: `附件总量过大（${(total / 1048576).toFixed(1)}MB，上限 20MB）` };
  }
  return { decoded };
}

// 兼容既有调用：只要错误字符串。
export function validateAttachments(attachments) {
  return decodeAttachments(attachments).error ?? null;
}

// 落盘：写 WORK_DIR/.ccm-uploads/<ts>-<rand>-<safeName>
// 返回 [{ absPath, name, mimeType, size }]
export async function saveAttachments(workDir, attachments, decoded = []) {
  const dir = join(workDir, UPLOAD_DIR);
  let symlink = rejectableSymlinkComponent(dir);
  if (symlink) throw new Error(`上传目录路径包含可疑符号链接: ${symlink}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  symlink = rejectableSymlinkComponent(dir);
  if (symlink) throw new Error(`上传目录路径包含可疑符号链接: ${symlink}`);
  const directoryStat = await lstat(dir);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('上传目录必须是普通目录');
  }
  await chmod(dir, 0o700);

  const dirResolved = resolve(dir);
  const saved = [];

  for (const [index, a] of attachments.entries()) {
    const content = decoded[index] ?? decodeBase64Strict(a.data);
    if (!content) throw new Error(`附件「${a.name}」数据不是合法 base64`);
    const detectedMimeType = detectImageMimeType(content);
    const fname = `${Date.now()}-${randomBytes(4).toString('hex')}-${sanitizeName(a.name)}`;
    const absPath = resolve(dir, fname);

    // 路径穿越检查
    if (absPath !== join(dirResolved, fname) || !absPath.startsWith(dirResolved + sep)) {
      throw new Error(`非法附件路径：${a.name}`);
    }

    // O_NOFOLLOW 防 symlink 攻击
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0);
    const fh = await open(absPath, flags, 0o600);
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }

    saved.push({
      absPath, name: a.name, mimeType: a.mimeType,
      size: content.length,
      kind: detectedMimeType ? 'image' : 'file',
      ...(detectedMimeType ? { detectedMimeType } : {}),
    });
  }
  return saved;
}

// 给 user_message 事件用的元数据（剥掉 absPath，不泄服务端路径）
export function toEventMeta(saved) {
  return saved.map(s => ({ name: s.name, mimeType: s.mimeType, size: s.size }));
}

// 定期清理过期上传的文件
export async function pruneExpiredUploads(workDir, maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!workDir) return { removed: 0, scanned: 0 };
  const dir = join(workDir, UPLOAD_DIR);
  
  // symlink 穿越检查
  const symlink = rejectableSymlinkComponent(dir);
  if (symlink) throw new Error(`上传目录路径包含可疑符号链接: ${symlink}`);

  try {
    const directoryStat = await lstat(dir);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('上传目录必须是普通目录');
    }
    await chmod(dir, 0o700);
  } catch (err) {
    if (err?.code === 'ENOENT') return { removed: 0, scanned: 0 };
    throw err;
  }

  const dirResolved = resolve(dir);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // 目录不存在或读取失败，无需清理
    return;
  }

  // 数出删了多少。删除必须可追溯——调用方拿不到数字的话，「附件不见了」这件事
  // 在日志里没有任何落点，而用户会以为是上传失败。
  let removed = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const absPath = resolve(dir, e.name);

    // 路径穿越检查
    if (absPath !== join(dirResolved, e.name) || !absPath.startsWith(dirResolved + sep)) {
      continue;
    }

    try {
      const st = await stat(absPath);
      if (Date.now() - st.mtimeMs > maxAgeMs) {
        await unlink(absPath);
        removed += 1;
      }
    } catch {
      // 忽略单个文件清理错误（可能已被删或无权限）
    }
  }
  return { removed, scanned: entries.length };
}
