# Contributing

Thanks for helping improve codex-mobile. Issues and pull requests are welcome in English or Chinese（中英文皆可）.

## Ground Rules

- TDD by default: write a failing test that expresses the expected behavior, make the minimal change, then run the real verification gates.
- Read the existing code, tests, and docs before changing anything; do not guess the architecture from the project name or old plan drafts.
- The production baseline is `codex app-server` over stdio (JSON-RPC 2.0). The legacy `codex exec --json` path is gone — do not reintroduce it.
- Routine work must not call the real Codex CLI or consume model tokens: E2E runs against the deterministic mock (`scripts/mock-server.js` + `scripts/mock-codex-app-server.js`). Real Codex smoke tests are reserved for explicit local-integration validation (see [docs/TESTING.md](docs/TESTING.md)).
- Never commit local state or secrets: `.env`, `data/`, `workdirs.json`, runtime `.jsonl` logs, Playwright reports, `.playwright-mcp/`.

## Development Setup

```bash
git clone https://github.com/Ike-li/codex-mobile.git
cd codex-mobile
npm install
cp .env.example .env
npm run dev
```

Node.js >= 20 is required. A real Codex CLI install is only needed for manual smoke testing and protocol work; pin it to the repo version:

```bash
npm i -g @openai/codex@$(cat .codex-version)
```

## Test Gates

All four gates must pass before a PR is ready:

```bash
npm run lint
npm test
npm run protocol:check
npm run test:e2e
```

`npm run test:ci` chains lint, unit tests, coverage thresholds, and Playwright E2E — the same set CI runs on Node 20 and 22. Coverage must not regress (`scripts/gates/check-coverage-delta.js`, baseline in `.coverage-baseline.json`).

`npm test` used to fail intermittently with `Unable to deserialize cloned data`, failing the whole of `test/server-integration.test.mjs`. It was not Node-25-specific and not unrelated to the code under test: CI hit the same error on Node 22, and the trigger was on our side. `node --test` multiplexes its child-v8 control frames and the child's raw stdout on one stream, and that file imports a fresh `server.js` per case (~60 times), writing startup banners, per-connection logs, and dotenv's randomly-worded promo banner into that stream. Silencing dotenv and routing `console.log` to `console.error` in the two server-starting test files took the same-session failure rate from 4/7 to 0/10. `npm run test:local` (`--test-isolation=none`) is still available for fast local iteration, but it shares one process across files, so `npm test` is the gate.

## Protocol Changes

The app-server protocol is pinned via `.codex-version` and the baseline in `.protocol/stable/`. When bumping the Codex CLI version, follow [docs/PROTOCOL_UPGRADE.md](docs/PROTOCOL_UPGRADE.md): regenerate the baseline, run the drift check, and update the bridge plus focused tests before accepting drift.

Two hard rules: experimental app-server methods stay behind the Labs product gate, and unknown items or notifications must keep a visible fallback envelope instead of being dropped.

## Commits and Pull Requests

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `refactor:`), matching the existing history.
- Keep PRs focused and include the tests that demonstrate the change (TDD).
- Update the maintained docs when behavior changes: `README.md` (English) and `README.zh-CN.md` (Chinese mirror) must stay in sync; `docs/` is currently maintained in Chinese.
- Doc structure is contract-tested in `test/acceptance-doc.test.mjs` — when reorganizing docs, update the contract first.
