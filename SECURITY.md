# Security Policy

codex-mobile is a local control plane for a real development machine. An approved browser can drive Codex inside the configured workspace, sandbox, and approval policy: it can read files, propose patches, request commands, and answer app-server prompts. Treat every remote deployment as high risk.

## Threat Model

- The Node gateway is the browser-facing trust boundary. Browsers never connect directly to `codex app-server`; one local app-server process is reached only through the gateway's routed HTTP/Socket.IO protocol.
- A remote browser first exchanges the static `AUTH_TOKEN` at `POST /auth/session`. The server issues an in-memory session bound to that browser's `deviceToken`; the remote Socket then authenticates with the HttpOnly cookie plus the same device token. Supplying the static token directly in a remote Socket handshake or HTTP query string is rejected.
- A valid session is not sufficient for a new device to control Codex. The device remains pending until an already approved device, the local TTY, or the owner-managed trust file approves it.
- Workspace allowlists, Codex sandbox modes, and approval policies limit what a turn should do, but they are guardrails rather than host isolation. Do not expose the gateway to untrusted networks or users.
- `fs/*` in the app-server protocol takes any absolute path: it assumes the client runs on the same machine, where physical access already implies trust. That assumption does not hold for a remote browser, so the gateway scopes every `fs:*` path to the workspace allowlist itself — realpath-normalised, separator-anchored, and resolved against the nearest existing ancestor for not-yet-created targets. Out-of-scope requests are refused and audited as `workspace_scope`.
- That scope guard prevents mistakes, not a determined attacker: an approved device can still ask the agent to read the same file. Its value is keeping `~/.ssh` and `~/.codex/auth.json` out of casual browsing, because leaked credentials are the one kind of damage that revoking a device cannot undo.
- Browser outbox state survives browser refresh, but server receipts, auth sessions, and failure windows are in memory. A server restart clears those in-memory protections/state. Unknown or formerly queued writes are quarantined: the browser first reconciles by `clientRequestId` against a surviving receipt even without a thread id, then uses `thread/read` when a stable thread exists. A never-attempted provisional request may retain its id while restoring/rebinding its target; an unresolved attempted write can only be replaced after an explicit warning with a fresh id and retry provenance.

## Deployment Rules

- With an empty `AUTH_TOKEN`, `HOST` must remain loopback. A non-loopback bind requires an `AUTH_TOKEN` of at least 32 characters; generate one with `openssl rand -hex 32`.
- Remote plaintext HTTP and Socket.IO are rejected by default. Put the gateway behind HTTPS and keep `CODEX_ALLOW_INSECURE_REMOTE=0`; the insecure override exists only for explicit local development.
- Remote Socket.IO requires an exact Origin in `CODEX_ALLOWED_ORIGINS`. Wildcards are not accepted.
- Trust `X-Forwarded-Proto` only from exact direct-peer IPs in `CODEX_TRUSTED_PROXY_IPS`. CIDR ranges, hostnames, wildcard proxy trust, and an untrusted forwarded header are not accepted. The proxy must overwrite the header with one value.
- A same-host HTTPS proxy should normally leave `HOST=127.0.0.1`. Bind `0.0.0.0` only when the proxy or network topology actually requires it.
- Prefer a private overlay or access-controlled tunnel. Never place this control plane directly on the public internet.
- Keep `CODEX_SANDBOX` and `CODEX_APPROVAL_POLICY` as restrictive as the workflow allows. Labs is disabled by default. Host-configuration operations (Codex config, plugins, marketplace, MCP tool calls, account logout) are reachable without an unlock step but require an explicit per-action confirmation and are audited. The former admin unlock was security theatre — the phrase was a source constant, any device that could open the page could unlock it, and at least three bypasses existed — so it was removed rather than hardened; the real boundary is the device credential.

## Authentication and Device Lifecycle

- The session cookie is `HttpOnly; SameSite=Strict` and gains `Secure` when the gateway verifies effective HTTPS. Its default TTL is seven days (`CODEX_SESSION_TTL_MS`), and it is not persisted by the server.
- `DELETE /auth/session` revokes the current session, clears the cookie, and disconnects sockets bound to it.
- The web UI lists connected devices (`devices:list`) with a 16-character `deviceRef`, last-seen and first-approved timestamps, source address, and Push subscription state. Revocation goes through `devices:revoke` by that reference; the gateway resolves it back to the full token, so the browser never receives one. The UI requires a destructive-styled confirmation that states the device is disconnected immediately and its Push binding invalidated.
- Denying a device revokes all of its sessions, removes its Push subscriptions, and disconnects it. An owner-initiated atomic replacement of `trusted-devices.json` is watched and revokes sessions and Push subscriptions even when that device is offline; remote sockets are disconnected, while an already connected loopback socket is deliberately preserved.
- If approval trust cannot be persisted, the target stays locked. If denial cannot be persisted, active sockets and sessions are still revoked fail-closed, while the caller receives `device_persist_failed` so the owner can repair durable state.
- Push subscription requires a valid session and approved device, a public HTTPS endpoint, and valid `p256dh`/`auth` keys. Before delivery the server rejects local/private/mixed DNS answers, pins the validated IP while preserving the endpoint TLS identity, applies one 10-second total timeout, and caps response data at 64 KiB. It persists before acknowledging success, keeps at most one current endpoint per device, and rechecks device trust before delivery. Approval/question notifications use generic text and a thread+need deep link; result/error notifications have no such deep link and may expose up to 180 characters of the upstream status/error message in the OS preview.

## Audit and Limits

- `security-audit.jsonl` records session issue/revoke, authentication failures, device decisions, Push subscription/pruning, and needs-you resolution. It uses owner-only O_APPEND writes, rotates at `CODEX_SECURITY_AUDIT_MAX_BYTES` (1 MiB by default), and keeps five generations (`.1`–`.5`) by default. Retention stays bounded on purpose — an always-on self-hosted service must not grow logs without limit — but a single generation was too short a window once file reads/writes became auditable, since the records that matter most are usually the old ones. Device/token identifiers are stored as hashed references; command, question, and answer bodies are excluded.
- `host-config-audit.jsonl` records host-configuration operation outcomes and missing-confirmation denials with recursively redacted summaries and upstream errors. Both audit files are owner-only; neither is tamper-evident or a non-repudiation system. Host-configuration audit retention is not currently bounded. Deployments that predate the rename keep their historical records in `admin-audit.jsonl`; that file is no longer appended to and can be archived or kept alongside.
- Authentication failures default to 5 per 60 seconds; only the pre-threshold denials and first rate-limited summary are audited per identity/window. Pending pairing defaults to 32 devices; Push defaults to 64 subscriptions. These are bounded in-memory controls, not a general per-message denial-of-service defense.
- Device trust, Push subscriptions, uploads, and audit files use owner-only storage. `.ccm-uploads` is created and repaired to mode 0700, files stay 0600, attachment input is only null/omitted or an array, and the business limits remain 10 MiB per file / 20 MiB total behind a 32 MiB Socket.IO wire cap. Upload and structured-input paths are validated, and remote image inputs are disabled by default with HTTPS/DNS/SSRF checks when explicitly enabled.

## Supported Versions

Pre-1.0: only the latest `master` receives security fixes.

## Reporting a Vulnerability

- Report privately via GitHub: [Security → Report a vulnerability](https://github.com/Ike-li/codex-mobile/security/advisories/new).
- Do not open a public issue for a suspected vulnerability.
- Include reproduction steps, impact, and the relevant deployment values without including secrets: bind topology, whether HTTPS terminates at a proxy, allowed Origin/trusted proxy configuration, sandbox/approval policy, enabled Labs/remote-image flags, and whether VAPID is configured. You should normally hear back within a week.
