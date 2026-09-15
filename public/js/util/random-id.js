// 随机 id 生成，**不依赖 secure context**。
//
// crypto.randomUUID 只在 secure context 里存在。实测（Chromium）：
//   http://127.0.0.1 / http://localhost → isSecureContext=true  → randomUUID 存在
//   http://<任意主机名>                 → isSecureContext=false → randomUUID undefined
// 而 crypto.getRandomValues 两种情况下都在。
//
// 直接调 randomUUID 的后果不是报错，是**静默失败**：明文远程接入
// （CODEX_ALLOW_INSECURE_REMOTE=1 的本机远程验收路径）下发消息会抛 TypeError，文字留在输入框，状态还显示 idle，界面上没有任何提示。
export function randomId() {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues !== 'function') {
    throw new Error('Web Crypto is required to generate secure random ids');
  }
  // 16 字节 = 128 位，与 UUIDv4 的随机位数同量级；投递去重全靠这个 id 不撞号。
  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
