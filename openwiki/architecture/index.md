# 文件

- [app-server 桥接层：传输、宿主与归属路由](app-server-bridge.md) - 网关如何用一条 codex app-server 子进程承载多个并行会话——AppServerTransport 收发 JSON-RPC 帧，AppServerHost 复用连接并把入站帧路由回正确的 runtime，ThreadRegistry 以 fail-closed 的方式回答「这一帧归谁」。
- [模块分层与 import 边界](module-boundaries.md) - 后端 src/ 六个域与前端 public/js/ 八个功能域的层序约定、组装根不可被反向 import、前后端三个具名共享模块的白名单，以及 check-import-boundaries 如何把这些约定变成会红的静态闸。
- [系统总览：手机控制面到 codex app-server](overview.md) - codex-mobile 的三段链路、进程模型、两个组装根与启动/关闭顺序，以及它为什么是「你本机那个 codex 的手机控制面」而不是另一个 agent。
- [Socket.IO 契约层与事件信封](socket-contract.md) - 网关对手机端暴露的全部 socket 事件与 HTTP 端点、ack 的成功与失败形状、instance 房间与多设备广播、agent:event 信封的 seq/epoch 语义，以及统一的错误出口与脱敏约束。
- [状态归属：不产生第二份真相](state-ownership.md) - 架构决定 A2 的判据与落地——thread/turn/item/配置/模型列表一律向 app-server 现问，网关落盘的七个文件各自凭什么不算第二份真相，以及守这条红线的两个不变量测试如何双向闭合。
