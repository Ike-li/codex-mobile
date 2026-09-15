// client-encoding.js —— 浏览器侧的编解码与设备身份生成。
//
// 从 app.js 的 IIFE 里搬出来的第二块（I-7）。这三个函数在 IIFE 里时零依赖、零 DOM，
// 却因为整个文件没有 export 而完全不可单测——它们各自都有会静默出错的边界：
//   · createDeviceToken   非 secure context 下没有 crypto.randomUUID
//   · urlBase64ToUint8Array  VAPID 公钥是 URL-safe base64，补位算错就订阅不上推送
//   · decodeBase64Text    多字节 UTF-8 不能按 latin-1 解
//
// `window.atob` 一律改成 `globalThis.atob`：浏览器里两者是同一个，而这样在 Node
// 测试里也能直接调。
import { randomId } from './random-id.js';

// 设备身份。**不能裸调 crypto.randomUUID**——它只在 secure context 里存在，而局域网
// http:// 访问正是本项目的主要场景之一，裸调过一次的后果是发消息静默失败。
//
// 这里复用 randomId()，而不是自己再写一遍同样的降级逻辑。搬出 IIFE 之前它是自己写的，
// 与 random-id.js 逐字重复；`9f5cf85` 的 commit 说明里点名过这次去重被一条源码文本断言
// 挡着（那条断言要求 app.js 里必须出现 `crypto.randomUUID()`）。那条断言已经删了。
export function createDeviceToken() {
  return `dev_${randomId()}`;
}

// VAPID 公钥用的是 URL-safe base64 且**不带补位**。直接喂给 atob 会失败，
// 所以要先补齐 `=` 再把 `-_` 换回 `+/`。补位算错的表现是订阅推送时抛
// InvalidCharacterError，而那句报错完全看不出是密钥格式的问题。
export function urlBase64ToUint8Array(base64String) {
  const input = String(base64String ?? '');
  const padding = '='.repeat((4 - input.length % 4) % 4);
  const base64 = (input + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = globalThis.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index);
  }
  return outputArray;
}

// 附件预览用。atob 给的是 latin-1 字节序列，必须经 TextDecoder 才能正确还原
// 多字节 UTF-8——直接当字符串用会把中文变成乱码。
// 解不出来时给空串而不是抛：调用点是预览渲染，一个坏附件不该让整块界面炸掉。
export function decodeBase64Text(dataBase64) {
  // ⚠ 搬迁时唯一一处有意的行为改动：原实现只有 try/catch，而 atob 会把非字符串
  // **强制成字符串**——`atob(null)` 实际解的是 "null"，那恰好是合法 base64，
  // 于是返回三个乱码字符而不是空串。非字符串输入在这里一律当「没有内容」。
  if (typeof dataBase64 !== 'string') return '';
  try {
    const bytes = Uint8Array.from(globalThis.atob(dataBase64), char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}
