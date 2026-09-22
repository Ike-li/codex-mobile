# Roadmap

This roadmap separates what is shipped and maintained from what is still open. It reflects the state of `master`; day-to-day tasks live in [GitHub issues](https://github.com/Ike-li/codex-mobile/issues), not here.

「已完成」依据 git 历史与当前测试门禁；「进行中 / 候选」中标注 *(待确认)* 的条目需要维护者确认后再排期。中文说明见每节。

## Shipped

Delivered and covered by the required lint, unit/integration, protocol, and mock E2E gates:

- **Shared app-server runtime** — one `codex app-server` per Node gateway process over stdio; `AppServerTransport`, `AppServerHost`, `ThreadRegistry`, and per-thread runtimes isolate thread/turn/request ownership while sharing one child. The supported deployment runs one gateway service per host.
- **Native thread source of truth** — `thread/list`, `thread/read`, `thread/resume`, and `thread/status/changed` drive history and activity across Codex App and Web; duplicate `sessions.json` metadata and JSONL history fallback are removed.
- **Approval and needs-you model** — command / file-change / permission / user-input requests use exact thread/turn/item/request routing, revisioned cross-thread aggregation, process-local idempotent decision replay/conflict rejection, upstream revocation, and legacy protocol fallbacks where the pinned app-server still emits them.
- **Streaming UI** — text deltas, reasoning (channel/kind partitioned), command/tool cards with exit codes, file-change and diff panels, plan panel, raw-envelope fallback for unknown items.
- **Reliable mobile shell** — SPA/PWA HTML/CSS shell with self-hosted external browser modules, multi-workspace routing, per-device views, stable `clientRequestId`, ACK/receipt replay, IndexedDB outbox quarantine/reconciliation across gateway epochs, user-confirmed retry for unresolved writes, bounded event catch-up, and `thread/read` rebuild after a gap or epoch change.
- **Native controls** — thread list/resume/archive/rename/delete, compact, rollback, model list, read-only fs, account/usage/rate-limits, MCP status, skills, external-agent-config import.
- **Host configuration** — config/plugin/marketplace/MCP/logout controls reachable without an unlock step, each requiring explicit per-action confirmation and owner-only redacted audit. The former unlock phrase was security theatre and was removed.
- **Labs (P3, experimental)** — web terminal via `command/exec`, thread turns/search with graceful degradation, realtime/remote-control notification tracking; gated behind `CODEX_P3_EXPERIMENTAL`.
- **Self-hosted security** — loopback-only without `AUTH_TOKEN`; remote HTTPS and exact Origin enforcement; trusted-proxy validation; device-bound HttpOnly sessions; pairing, revocation, bounded auth/Push limits; owner-only redacted security audit.
- **Structured inputs & Push** — validated uploads map to `localImage`/`mention`, enabled skills and guarded HTTPS images remain structured. For approval/question needs, authenticated device-bound VAPID Push uses a generic body plus an exact thread+need deep link; result/error events also notify, without that deep link, and may expose up to 180 characters of status/error text in the OS notification preview.
- **CI & protocol gate** — GitHub Actions on Node 20/22, coverage thresholds + delta, and app-server protocol drift/coverage check against `.protocol/stable/`.

## In Progress

- No active roadmap item is declared here. New work should start as an issue with an acceptance boundary before it moves into this section.

## Candidates

Not scheduled; listed for direction. Promote to an issue before starting.

- **Real ChatGPT device-code login smoke** — automation covers the mock; real-account `chatgptDeviceCode` flow still needs a manual/CI path. *(待确认)*
- **Native pagination/search** — keep `thread/read` / `thread/list` as the stable truth surface; adopt `thread/turns/list`, `thread/items/list`, or `thread/search` only after they are exported by the pinned stable protocol. *(待确认)*
- **Official remote-control pairing** — track `remoteControl/*` maturing upstream; evaluate replacing self-managed device auth when the official pairing lands. *(待确认)*
- **Realtime voice** — `thread/realtime/*` currently notification-only; real audio input is out of scope until prioritized. *(待确认)*
- **Delta coalescing** — bridge→frontend high-frequency delta batching for very long logs (performance, not correctness). *(待确认)*

## Non-Goals

- `codex cloud` cloud tasks (go through the ChatGPT backend, not app-server).
- A hosted/multi-tenant backend — this stays a single-user local control plane.
- Reimplementing TUI-local rendering details (transcript scrolling, keybindings, onboarding).
