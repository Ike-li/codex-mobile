# 文件

- [自检、指标与运行日志](diagnostics-and-observability.md) - doctor 的判定层与探测层为何分开、它凭什么等同于 server 启动时看到的配置、指标契约 OPS-01 的双向闭合、/health 与 /metrics 的出口，以及审计日志与 RPC 日志的轮转与权限策略。
- [安全边界：绑定、令牌、设备配对与脱敏](security-model.md) - 默认只绑 loopback 与显式开远程的代价、入册令牌与设备专属凭证、设备配对握手与待批上限、鉴权失败的窗口限流、Origin 与传输安全判定，以及日志与 RPC 帧的脱敏闸。
- [配置系统与装机路径](setup-and-configuration.md) - 配置的单一事实源 CODEX_SCHEMA、codex.config.json 与 .env 的源选择与优先级合并、启动期校验为何按 kind 分档、装机向导的拒绝矩阵、配置 CLI 的全或无写入与只读键，以及二维码配对入口。
