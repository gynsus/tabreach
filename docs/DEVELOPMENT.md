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

### Signing and notarization (Phase 8)

Distribution to other Macs needs, in addition to the current ad-hoc build:

- an Apple Developer Program membership and a **Developer ID Application** certificate in the build machine's keychain (`mac.identity` in `electron-builder.yml`);
- notarization credentials for `notarytool`: an App Store Connect API key (key id, issuer id, `.p8`) or an Apple ID with an app-specific password, provided to electron-builder through environment variables in CI;
- hardened runtime (already on) with an entitlements file. Electron needs `com.apple.security.cs.allow-jit`; `com.apple.security.cs.allow-unsigned-executable-memory` only if a crash report shows it is required. No camera, microphone or other entitlements.
- a DMG target and stapling of the notarization ticket.

Not yet verified: a first launch on a clean macOS user account (Gatekeeper path). That check belongs to Phase 8 together with signing.

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
packages/protocol       IPC envelope, request and event registries (Zod), RpcPeer, bridge types, audit catalogue,
                        shared secret redaction, logger contract
packages/core           SQLite (node:sqlite), migrations, transactions, CoreService, command log (idempotency),
                        prospects (companies, contacts, tags, normalization, CSV import/export),
                        suppressions, audit log and timelines, settings, secrets, job queue and dispatcher,
                        side-effect ledger, channel contract and test channel, campaigns (engine, approvals,
                        policy), email (IMAP/SMTP, Gmail API, inbox, replies), AI gateway and providers,
                        research, AI drafts and draft checks
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

## Jobs and external actions

- Background work is a row in `jobs` (`packages/core/src/jobs`). Enqueue inside the same transaction
  as the state change that needs it; the dispatcher wakes on enqueue and on the earliest `run_at`.
- A job type declares a Zod payload, concurrency, attempts and whether it is side-effecting. Throw
  `RetryableError` (backoff or explicit `retryAt`) or `PermanentError`; anything else retries as
  `unexpected`. Exhausted or too old → `dead` (shown under “Needs attention”).
- Anything that leaves TabReach goes through `executeSideEffect` (`packages/core/src/ledger`): it
  reserves the intent, marks `executing` before the call and reconciles instead of re-sending after a
  crash (ADR 018, ADR 021). Never call a channel's `send` directly.
- `TestChannel` stands in for the outside world in tests and can simulate rejection, an unconfirmed
  send and a crash before or after delivery.

## Email

- Core talks SMTP (nodemailer's `SMTPConnection`, driven stage by stage) and IMAP (imapflow). Both are
  behind `MailClients` (`packages/core/src/email/transport.ts`); tests use `FakeMail`, and the SMTP
  outcome rules are also tested against a local `smtp-server` (plaintext on 127.0.0.1 only through
  `createImapSmtpClients({ plaintextLoopback: true })` — the product always requires TLS).
- Gmail: `packages/core/src/email/gmail.ts` (OAuth + API over `fetch`), tested against `FakeGoogle`, which
  checks PKCE and bearer tokens. Main's loopback listener is `apps/desktop/src/main/oauth-loopback.ts`.
- Passwords are stored with `SecretStore` (encrypted by main); account DTOs and logs never contain them.

## AI

- All provider calls go through `AiGateway` (`packages/core/src/ai`). Tests use `FakeAnthropic` and `FakeChatCompletions` (OpenRouter/OpenAI), which record
  requests (key, model, system/user text, schema) and answers what the test queued. CI never calls a real provider.

## User interface

Screens: Contacts, Companies (with research), Do not contact, Campaigns (editor with template or AI steps,
schedule, approval and checks, people, history), Inbox, Approvals (keyboard queue: A / E / S / R, J / K; checks,
facts and versions), Activity (by category), Status (with "Needs attention"), Settings (tabs: general, email
accounts, AI, contact policy).

React + Tailwind CSS 4 + TanStack Query/Table/Virtual + React Router (hash) + i18next (ADR 019).

- Strings: add every user-facing string to `apps/desktop/src/renderer/src/i18n/en.ts` **and** `ru.ts`.
  `ru.ts` is typed against the English catalog, so `pnpm typecheck` fails on a missing key.
- Errors: core sends keys (`email.invalid`); translate them under `errors.*`.
- Colors: use the semantic tokens (`bg-paper`, `text-soft`, `bg-accent`, `text-bad`, …) defined in
  `styles.css`; dark mode follows macOS automatically.
- The interface language is stored in core (`settings.ui`) and switched in Settings.

## Logs

JSON lines (pino), one file per process: `main.log`, `core.log`, `worker.log`. Secret-looking keys
(`password`, `token`, `apiKey`, `plaintext`, `ciphertext`, `cookie`, `authorization`, …) are redacted
at any nesting level up to 8; anything deeper is replaced whole (fails closed). Files rotate at 10 MB, five generations kept.
