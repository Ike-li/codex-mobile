// public/js/app/client-log.js —— 把前端未捕获的错误报给服务端。
//
// 【为什么值得做】此前前端错误只活在用户自己的控制台里：手机上打不开控制台，
// 而最要命的崩溃恰恰发生在手机上。服务端零信息意味着「用户说打不开」这句话
// 没有任何可查的东西跟在后面。
//
// 收敛全在服务端（形状校验 + 长度钳制 + 脱敏 + 限流）。这一层只负责**取到**错误，
// 并且自己绝不抛——上报失败不该变成第二个错误。
export function installClientErrorReporting({ socket, target = globalThis } = {}) {
  const report = payload => {
    try { socket?.emit?.('logs:clientError', payload); } catch { /* 上报失败不该变成第二个错误 */ }
  };

  target.addEventListener?.('error', event => {
    report({
      message: String(event?.message || event?.error?.message || 'unknown error'),
      source: `${event?.filename || ''}:${event?.lineno ?? ''}`,
      stack: String(event?.error?.stack || ''),
    });
  });

  // unhandledrejection 与 error 是两条独立的路径：async 里抛出的东西不走 window.onerror。
  // 只接一条的话，恰恰是 socket 回调、fetch 链这类最容易出错的地方报不上来。
  target.addEventListener?.('unhandledrejection', event => {
    const reason = event?.reason;
    report({
      message: String(reason?.message || reason || 'unhandled rejection'),
      source: 'unhandledrejection',
      stack: String(reason?.stack || ''),
    });
  });
}
