# codex-mobile

[![CI](https://github.com/Ike-li/codex-mobile/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/Ike-li/codex-mobile/actions/workflows/test.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

English | [简体中文](./README.zh-CN.md)

When your local [Codex CLI](https://github.com/openai/codex) uses a custom `base_url` and API key, official ChatGPT remote control cannot pair with that host. This project is the phone control plane for the `codex app-server` already running on your machine — same local workspace, same approval boundaries, same native threads and streaming agent events.

| Streaming chat | Approval card |
|---|---|
| ![Streaming chat on a phone](docs/assets/chat.png) | ![Approval card on a phone](docs/assets/approval.png) |

> Screenshots from the deterministic mock app-server (`npm run test:e2e` harness) — no real Codex tokens involved. **See the full [feature tour →](docs/SHOWCASE.md)**

## Features

- Streaming conversations with the full agent event feed: text deltas, reasoning, command output
- Tool and command cards with exit codes, file-change summaries, and a visible raw-envelope fallback for unknown event types; history snapshots rebuild those cards, not only text
- A read-only workspace sheet from the project name: browse files, inspect git changes, and `@`-mention workspace paths without concatenating them into the prompt
- A delayed connection banner, confirm/prompt sheets, pasted-image attachments, and syntax-highlighted code copy buttons
- Approval cards — approve or deny exec/patch requests from your phone, mirroring Codex CLI approval policies
- Slash commands with suggestions (`/status`, `/diff`, `/review`, `/permissions`, …)
- Structured inputs: validated owner-only uploads become `localImage` or `mention` parts; enabled skills are supported, while guarded HTTPS images require the default-off `CODEX_ALLOW_REMOTE_IMAGES=1`
- Native app-server threads are the only conversation source of truth (`thread/list`, `thread/read`, `thread/resume`, `thread/status/changed`)
- Reliable mobile delivery with stable `clientRequestId`: IndexedDB persists the outbox, the in-memory receipt ledger deduplicates within one gateway lifetime, and unknown results are quarantined and reconciled through the ledger or `thread/read`. A vanished provisional instance is restored or safely rebound only for a never-attempted request; unresolved attempted writes require an explicit warning and a fresh-id retry.
- Multi-workspace routing (`WORK_DIR` + `WORK_DIRS` allowlist), isolated per-device views, and multiple active thread tabs over one shared app-server process
- Cross-thread “needs you” aggregation, device-bound Web Push for needs-you deep links and result/error notifications, and an installable PWA with mobile-safe layouts

## How It Works

```text
phone browser / PWA
  <-> Socket.IO
server.js  (Express 5 gateway: auth, ACKs, routing, recovery, push)
  <-> ThreadRuntime[] + ThreadRegistry
  <-> one AppServerHost + AppServerTransport
  <-> stdio JSON-RPC 2.0
one codex app-server process
```

There is no hosted backend. The browser talks to a Node gateway on your dev machine. Each supported gateway process owns one shared `codex app-server` process and many native threads; runtime ownership, request correlations, and each device's current view determine routing. Run one gateway service per host. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full architecture and security model.

## Quick Start

Prerequisites:

- Node.js >= 20
- [Codex CLI](https://github.com/openai/codex) installed and authenticated (`codex` on `PATH`, or set `CODEX_BIN`); the protocol baseline is pinned to the version in `.codex-version`

```bash
npm install
cp .env.example .env
npm test
npm start
```

Open `http://127.0.0.1:3001` on the same machine.

From a phone, the only recommended path is Tailscale Serve: keep the gateway on loopback and publish it as tailnet HTTPS.

```bash
tailscale serve 3001
```

Set `AUTH_TOKEN` to at least 32 characters, `CODEX_ALLOWED_ORIGINS` to the exact `https://<machine>.<tailnet>.ts.net` URL Serve prints, and `CODEX_TRUSTED_PROXY_IPS=127.0.0.1,::1`. Use Serve, not Funnel. Pair the new device before it can send. Other HTTPS proxies are in [docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md), not here.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address; keep loopback behind a same-host HTTPS proxy |
| `AUTH_TOKEN` | empty | Bootstrap secret; non-loopback binds require at least 32 characters |
| `WORK_DIR` | — | Primary Codex workspace |
| `WORK_DIRS` | empty | Extra workspaces: comma-separated dirs, or a JSON array file such as `workdirs.json` |
| `CODEX_BIN` | `codex` | Path to the Codex CLI binary |
| `CODEX_DATA_DIR` | `./data` | Device, Push, and audit state root |
| `CODEX_APPROVAL_POLICY` | `on-request` | `untrusted` \| `on-failure` \| `on-request` \| `granular` \| `never` |
| `CODEX_SANDBOX` | `workspace-write` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `CODEX_INPUT_QUEUE_LIMIT` | `20` | Max queued inputs during a busy turn |
| `IDLE_TIMEOUT_MS` | `600000` | Busy-turn silence timeout; interrupt after no runtime activity |
| `CODEX_ALLOWED_ORIGINS` | empty | Exact comma-separated browser origins for remote Socket.IO |
| `CODEX_TRUSTED_PROXY_IPS` | empty | Exact direct-peer IPs allowed to supply `X-Forwarded-Proto` |
| `CODEX_SESSION_TTL_MS` | `604800000` | In-memory, device-bound HttpOnly session lifetime |
| `CODEX_SECURITY_AUDIT_MAX_BYTES` | `1048576` | Active security audit size before one owner-only rotation is retained |
| `CODEX_ALLOW_REMOTE_IMAGES` | `0` | Explicitly enable guarded HTTPS image URL inputs |
| `CODEX_P3_EXPERIMENTAL` | `0` | Keep Labs out of the core surface unless explicitly enabled |
| `VAPID_SUBJECT` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | empty | Enable device-bound Web Push (all three required) |

## Commands

```bash
npm run lint            # ESLint
npm test                # unit / integration / protocol / security / doc contracts (node:test)
npm run protocol:check  # app-server protocol drift check against .protocol/stable/
npm run test:e2e        # Playwright mobile E2E against the mock app-server
npm run test:ci         # lint + tests + coverage gates + E2E
```

`npm run test:e2e` connects Playwright to `scripts/mock-server.js` — it never calls the real Codex CLI and never consumes model tokens.

## Security

- Empty `AUTH_TOKEN` means loopback-only; non-loopback binds require at least 32 characters.
- Remote HTTP is rejected by default. Remote Socket.IO additionally requires an exact Origin allowlist and a device-bound HttpOnly session obtained from `POST /auth/session`.
- New browsers remain locked/pending until approved; their upstream events are discarded. Device denial disconnects its sockets and removes bound sessions and Push subscriptions. External trust-file removal applies the same session/Push revocation, but deliberately preserves an already connected loopback socket.
- Device, Push, upload, and redacted audit state is owner-only. CSP/frame protections, upload validation, SSRF guards, and bounded auth/pairing/Push limits reduce exposure.
- Labs is disabled by default. Host-configuration operations have no gate to unlock but require an explicit per-action confirmation and are audited.

This is a control plane for a real development machine — treat any remote exposure as high risk. See [SECURITY.md](SECURITY.md) for the threat model and how to report vulnerabilities.

## Key Files

- `server.js` — HTTP/Socket.IO gateway, authentication, receipts, routing, recovery, Push, and needs-you aggregation
- `app-server-transport.js` / `app-server-host.js` — the single stdio transport and shared app-server multiplexer
- `thread-runtime.js` / `thread-registry.js` — per-thread semantics and exact ownership/routing
- `agent-appserver.js` — `ThreadRuntime` implementation and Codex event mapping
- `public/index.html` — mobile SPA/PWA HTML shell (markup only; no inline `<style>`)
- `public/css/app.css` — the application stylesheet, linked after the two highlight.js themes so its overrides win
- `public/js/app.js` — external browser application module: UI interactions, approval cards, and native panels
- `scripts/mock-codex-app-server.js` — deterministic Codex protocol mock for E2E
- `.protocol/stable/` — pinned app-server protocol baseline for drift checks

## Documentation

- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) — first successful local and mobile conversation, approval, history resume, PWA, and Push
- [docs/WEB_UI_MAP.md](docs/WEB_UI_MAP.md) — map of every visible Web UI region and control
- [docs/RECIPES.md](docs/RECIPES.md) — task-oriented recipes for analysis, edits, approvals, attachments, cross-surface resume, and recovery
- [docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md) — availability, configuration, output, and persistence matrix
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — symptom-first Web, auth, thread, attachment, Push, and feature troubleshooting
- [docs/CONCEPTS.md](docs/CONCEPTS.md) — thread/runtime, routing, reliable delivery, needs-you, and Codex App/Web concepts
- [docs/SHOWCASE.md](docs/SHOWCASE.md) — visual feature tour (what it looks like and what it does)
- [docs/WEB_CAPABILITIES.md](docs/WEB_CAPABILITIES.md) — complete Web UI capability reference: visible state, actions, inputs, and results
- [docs/GUIDE.md](docs/GUIDE.md) — end-to-end walkthrough from install to installing the PWA
- [docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md) — phone access: Tailscale Serve is the recommended path; other HTTPS proxies and PWA/Push constraints live here
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — current architecture and security model
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — Codex app-server protocol reference (methods, events, coverage)
- [docs/API.md](docs/API.md) — interface reference (HTTP routes + Socket.IO events with signatures)
- [docs/TESTING.md](docs/TESTING.md) — test gates, acceptance matrix, and manual smoke checklist
- [docs/SMOKE_MATRIX.md](docs/SMOKE_MATRIX.md) — 71 visual acceptance cases covering 123 of 131 interface and cross-layer test points; judged by what is visible on screen, so a person and a browser agent run the same document
- [docs/PROTOCOL_UPGRADE.md](docs/PROTOCOL_UPGRADE.md) — Codex app-server protocol upgrade runbook
- [ROADMAP.md](ROADMAP.md) — shipped / in progress / candidates

The deep-dive docs are currently maintained in Chinese; translations are welcome. Documentation policy: only actively maintained documents are treated as sources of truth. One-off sprint plans and stale QA context are removed; the generative research drafts behind the protocol docs are kept read-only under [docs/archive/](docs/archive/) and clearly marked as unmaintained. Nothing from the archive should be re-promoted unless it is explicitly maintained again.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The project is TDD-first: write a failing test, make the minimal change, then run the four gates above. Issues and PRs are welcome in English or Chinese.

## License

[AGPL-3.0-only](LICENSE). If you run a modified version of this software as a network service, the AGPL requires you to offer the modified source to its users.
