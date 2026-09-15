// R-19：自托管产品最高频的求助是「连不上」，而这条链路有六层。笼统显示 offline，用户
// 只能一层层猜——而每层的处理方式完全不同（换网 / 查隧道 / 重启服务 / 看 codex / 换上游）。
//
// 判定给出**最外层的坏点**：修好它之前，里层是好是坏都无从验证，所以报里层只会误导。
export const HEALTH_LAYERS = ['browser', 'network', 'gateway', 'appServer', 'codex', 'upstream'];

const OK = { ok: true, layer: null, title: '一切正常', detail: '', actionable: false };

export function diagnoseHealth({
  browserOnline = true,
  gatewayReachable = true,
  socketConnected = true,
  appServerRunning = true,
  codexError = null,
  upstreamError = null,
} = {}) {
  if (browserOnline === false) {
    return layer('browser', '设备已离线', '这台设备没有网络连接。检查 Wi-Fi 或蜂窝数据。', true);
  }
  if (gatewayReachable === false) {
    return layer('network', '连不到控制台', '设备有网，但到不了运行控制台的那台机器。检查是否在同一网络，或隧道是否还开着。', true);
  }
  if (socketConnected === false) {
    return layer('gateway', '控制台未响应', 'HTTP 能通但实时连接没建立。控制台进程可能正在重启，或被反向代理挡掉了 WebSocket。', true);
  }
  if (appServerRunning === false) {
    return layer('appServer', 'codex 进程不在', '控制台正常，但宿主机上的 codex app-server 没有运行。任务无法开始，已在跑的会停。', true);
  }
  if (codexError) {
    return layer('codex', 'codex 报错', String(codexError), true);
  }
  if (upstreamError) {
    // 上游的问题不在这台机器上——把它标成不可操作，免得用户去重启一堆没关系的东西。
    return layer('upstream', '模型上游报错', String(upstreamError), false);
  }
  return { ...OK };
}

function layer(name, title, detail, actionable) {
  return { ok: false, layer: name, title, detail, actionable };
}
