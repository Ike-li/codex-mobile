# 文件

- [审批闭环与「需要你」登记](approvals-and-needs-you.md) - 审批请求从 app-server 到手机再回到协议的完整路径——ApprovalBroker 如何同时兜住两代审批方法，NeedsYouRegistry 如何跨会话汇总待办并区分重复、冲突与结果未知，以及审计与推送如何保证「需要人时叫得到人」。
- [消息投递：不丢不重与断线恢复](message-delivery.md) - 端到端的投递不变量 DELIVER-01 如何落地——clientRequestId 幂等、服务端回执账本、浏览器 IndexedDB outbox 的排队与补发、message:reconcile 的二次核对、catch-up 的增量重放与快照重建，以及 gatewayEpoch 的作用。
- [ThreadRuntime：单 thread 语义运行时](thread-runtime.md) - 一个 instanceId 对应一条 thread 的运行时——start/resume 就绪、turn 启动与转向、输入队列与排空、背压重试、中断的 turnEpoch 保护、idle 回收，以及协议通知到统一事件信封的映射。
- [未读位点、注意力与推送通知](unread-and-notifications.md) - 三条正交的注意力轴为什么不能合并，未读判定的纯函数与跨设备归并的方向差异（READ-01），以及 Web Push 的订阅、VAPID、DNS pin 与 SSRF 防护，还有 Service Worker 的实际职责范围。
