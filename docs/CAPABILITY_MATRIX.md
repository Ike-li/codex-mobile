# 能力矩阵

本文快速区分“已经实现”“默认可用”“需要配置”和“是否跨重启持久化”。详细操作见 [WEB_CAPABILITIES.md](WEB_CAPABILITIES.md)。

## 状态说明

- **默认**：正常本机配置即可使用；
- **条件**：需要 HTTPS、VAPID、feature flag、账号或 app-server 能力；
- **进程内**：gateway 重启后不保证保留；
- **原生**：由 Codex app-server thread 持久化；
- **浏览器**：保存在当前浏览器 IndexedDB/localStorage。

## 核心聊天与输出

| 能力 | 可用性 | 用户入口 | 返回形式 | 持久化/边界 |
|---|---|---|---|---|
| 普通对话 | 默认 | 输入框/发送 | ACK + text delta + result | 原生 thread |
| Reasoning | 条件于模型/协议 | 消息区 | summary/full reasoning | 原生事件/历史能力取决于 app-server |
| 命令与工具 | 默认，受权限约束 | Codex 发起 | 卡片、实时输出、exit code | 原生 thread |
| MCP/Search | 条件于配置/模型 | Codex 发起 | MCP/Search 卡片 | 原生 thread |
| File change/Diff/Plan | 默认，取决于任务 | 消息区或 slash 命令 | 结构化卡片 | 原生 thread |
| 中断 | 默认 | 主按钮停止图标 | ACK + turn 终态 | 不持久化为浏览器状态 |
| Steer/队列 | 默认 | 进行中再输入后点第二颗发送箭头 | steered 或 queued 气泡 | runtime 进程内队列 |

## 历史、恢复与多设备

| 能力 | 可用性 | 用户入口 | 返回形式 | 持久化/边界 |
|---|---|---|---|---|
| Thread 列表/历史/续接 | 默认 | Threads/历史抽屉 | thread/list/read/resume | Codex 原生 |
| Rename/Archive/Delete | 默认 | thread 操作菜单 | ACK + thread event | Codex 原生 |
| Compact/Rollback/Fork | 默认，取决于协议 | 抽屉/标签 | ACK + 更新 thread | Codex 原生 |
| 多 runtime 视图 | 默认 | 顶栏 + / 项目行 ＋ / 历史 thread | scoped init/events | gateway 进程内 |
| 多设备视图隔离 | 默认 | 各设备独立操作 | 目标 room 事件 | 每 Socket 视图 |
| 短断线 catch-up | 默认 | 自动 | seq/epoch 增量 | runtime 有界 buffer |
| Gap snapshot 重建 | 默认 | 自动 | thread/read snapshot | Codex 原生 |
| Outbox | 默认 | 自动 | pending/reconcile 状态 | 浏览器 IndexedDB |
| Receipt ledger | 默认 | 自动 | duplicate/receipt replay | gateway 进程内 |
| Needs-you 聚合 | 默认 | 顶部待办区 | revisioned snapshot/change | gateway 进程内 |

## 输入、控制面与移动能力

| 能力 | 可用性 | 用户入口 | 返回形式 | 持久化/边界 |
|---|---|---|---|---|
| 文本 | 默认 | 输入框 | user message + ACK | outbox/原生 thread |
| 文件附件 | 默认 | `+` | mention/localImage | owner-only 临时文件 |
| Workspace mention | 默认 | `@` 搜索或工作区 sheet | mention | 必须在 runtime cwd 内 |
| 工作区文件浏览 | 默认只读 | 抽屉 → 设备旁的 Files | `fs:readDirectory` / `fs:readFile` | 不写盘 |
| 工作区路径作用域 | 始终 | 越界时报「路径不在允许的工作区内」 | 服务端强制 + `workspace_scope` 审计 | 审计落盘 |
| 已接入设备列表 | 始终 | 抽屉 → 设备 | `devices:list` | 读信任表 |
| 撤销某台设备 | 始终 | 设备面板的撤销（危险色二次确认） | `devices:revoke` | 撤信任 + 清推送订阅 |
| Git 改动 | 默认只读 | 工作区 sheet「改动」 | `git:status` / `git:diff` | 非 git 仓明确失败 |
| 连接横幅 | 默认 | 自动 | 延迟出现的可读状态 | 浏览器进程内 |
| 连接延迟芯片 | 默认 | 顶栏 | `conn:ping` ACK 往返 | 浏览器进程内 |
| 确认/输入 sheet | 默认 | 删除、重命名、回退、重试 | 替代原生 confirm/prompt | 不持久化 |
| Skill | 条件于 enabled skills | Skills | skill input | 发送前重新校验 |
| 模型/思考强度/审批/沙箱 | 条件于账号/模型 | 输入区弹层 | `turn/start` 覆盖项 | 当前 runtime |
| 会话模式 Chat/Plan | Plan 禁用，等待已验证的写入能力 | 会话设置 / `/plan` `/chat` | 不支持时提示并保留草稿；不伪报下一轮应用 | 只认上游确认，不恢复本地 Plan 选中态 |
| 权限预设 | 主机限制读取成功且允许该组合 | 会话设置 | 下一轮 `approvalPolicy` / `approvalsReviewer` / `sandboxPolicy` | 浏览器版本 2 记录；服务端检查限制，状态区显示已生效值 |
| Files/Account/MCP/Skills | 默认只读，取决于 app-server | 抽屉 | 原生数据面板 | 不复制为第二事实源 |
| 外部配置 Import | 条件于检测结果 | Import | importId/状态事件 | app-server 管理 |
| PWA | 条件于安全上下文 | 浏览器安装 | standalone 页面 | 浏览器安装状态 |
| Web Push | 条件于 HTTPS+VAPID+批准设备 | Push 入口 | 系统通知 | 设备绑定订阅持久化 |

## 条件能力与持久化边界

| 能力 | 默认状态 | 启用条件 | 主要限制 |
|---|---|---|---|
| Remote image URL | 关闭 | `CODEX_ALLOW_REMOTE_IMAGES=1` | 仅公网 HTTPS，DNS pin/SSRF 校验 |
| Labs | 关闭 | `CODEX_P3_EXPERIMENTAL=1` | 实验 API，进程 ID 精确归属 |
| 宿主配置（config/插件/marketplace/MCP/登出） | 始终 | 抽屉 → 宿主配置，每动作独立确认 | owner-only 审计 | 改宿主机配置 |
| ChatGPT device login | Web 不提供 | 本机 `codex` 登录或 config.toml | 网页不启动 device-code |
| 跨 gateway exactly-once | 不提供 | — | ledger 不持久化；未知写不盲发 |
| 草稿持久化 | 不提供 | — | 未发送文本刷新可能丢失 |
| Needs-you 跨 gateway 恢复 | 不提供 | — | registry 是进程内状态 |

如果页面入口与本表不一致，先检查 feature manifest、`.env` 和本机 app-server 能力，再查看 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
