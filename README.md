# codex-chat-mobile

[![CI](https://github.com/Ike-li/codex-chat-mobile/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/Ike-li/codex-chat-mobile/actions/workflows/test.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

本机 [Codex CLI](https://github.com/openai/codex) 使用自定义 `base_url` 和 API key 时，官方 ChatGPT 远控无法与这台主机配对。本项目是这台开发机上已在运行的 `codex app-server` 的手机控制面：同一个本地工作区、同一套审批边界、同一条原生 thread 和同样的流式 agent 事件。



## 许可证

本项目以 [AGPL-3.0-only](LICENSE) 发布：如果你把修改版作为网络服务运行，AGPL 要求向其用户提供修改后的源码。
