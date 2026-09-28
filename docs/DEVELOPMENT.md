# Development

How to set up, run, test and package TabReach. Commands here are the ones CI runs.

## Prerequisites

- macOS on Apple Silicon (primary target).
- **Node.js 24.21 or newer** — pinned in `.nvmrc`. With nvm: `nvm install && nvm use`.
- **pnpm 12** — enable it through Corepack: `corepack enable` (the version comes from `packageManager` in `package.json`).
- **Google Chrome** in `/Applications` or `~/Applications`. Browser tests and the app use the installed Chrome.
- Xcode Command Line Tools (for `codesign` during packaging): `xcode-select --install`.

No Docker, database server or other services are needed.

## Install

```bash
pnpm install
```

Install scripts are denied by default; the allowlist lives in `pnpm-workspace.yaml` (`allowBuilds`).
Electron downloads its binary the first time it runs.

## Run

```bash
pnpm dev
```

Starts the Electron app with hot reload. Development data goes to
`~/Library/Application Support/TabReach-dev/` (database in `data/app.db`, logs in `logs/`), separate
from a packaged installation. Set `TABREACH_USER_DATA_DIR=/some/dir` to use another location.

The status screen shows core, database, secret storage, browser worker and Chrome. **Run check** opens
Chrome with a throwaway profile, loads `https://example.com`, reads the title and closes.

## Test

```bash
pnpm test           # unit + integration (Vitest, real SQLite files in temp dirs)
pnpm test:browser   # browser worker against local fixture pages with the installed Chrome
pnpm test:e2e       # builds the app and runs Electron E2E with Playwright
pnpm check          # typecheck + lint + format check + test + test:browser
```

Individual pieces:

```bash
pnpm typecheck
pnpm lint
pnpm format        # rewrite files with Prettier
pnpm format:check
```

Browser tests never touch live third-party sites. The fixture site can be served by hand:

```bash
pnpm --filter @tabreach/fixture-sites serve
```

## Package

```bash
pnpm package
```

Produces `apps/desktop/release/mac-arm64/TabReach.app`: ad-hoc signed, Electron fuses applied
(`RunAsNode` off, Node inspector off, ASAR integrity on). Developer ID signing and notarization come
in Phase 8. The packaged app stores data in `~/Library/Application Support/TabReach/` and logs in
`~/Library/Logs/TabReach/`.

### Self-check

Because the fuses disable the Node inspector, automation tools cannot attach to the packaged app.
Use the built-in diagnostics mode instead:

```bash
apps/desktop/release/mac-arm64/TabReach.app/Contents/MacOS/TabReach --self-check
apps/desktop/release/mac-arm64/TabReach.app/Contents/MacOS/TabReach --self-check=https://example.com
```

It starts core and the worker without a window, checks every component over the same protocol the
UI uses, optionally runs a Chrome launch check against the URL, prints one
`TABREACH_SELF_CHECK {json}` line and exits `0` when everything is healthy, `1` otherwise.

## Repository layout

```text
apps/desktop            Electron main, preload, renderer (React), process entry points, packaging
packages/protocol       IPC envelope, message registry (Zod), RpcPeer, bridge types, logger contract
packages/core           SQLite (node:sqlite), migrations, settings, secrets, CoreService
packages/browser-worker Chrome detection, Playwright launch check, BrowserWorker
packages/adapter-packs  Adapter pack schema (ADR 017)
fixtures/sites          Local pages for browser tests
```

Import boundaries between these are enforced by ESLint (`eslint.config.js`); see `CLAUDE.md` §3.1.

## Database

- Engine: SQLite through Node's built-in `node:sqlite` (ADR 011) — no native modules.
- Migrations: plain SQL in `packages/core/src/db/migrations.ts`, numbered 1..n, applied by core on
  startup. Applied migrations are checksummed; editing one makes core refuse to start.
- Before migrating an existing database, core writes a local recovery backup to `data/backups/`
  with the SQLite backup API.

To add a migration, append `{ version: n + 1, name, sql }` to the list and cover it in
`migrate.test.ts` if it contains logic beyond plain DDL.

## Logs

JSON lines (pino), one file per process: `main.log`, `core.log`, `worker.log`. Secret-looking keys
(`password`, `token`, `apiKey`, `plaintext`, `ciphertext`, `cookie`, `authorization`, …) are redacted
at any of the first three nesting levels. Files rotate at 10 MB, five generations kept.
