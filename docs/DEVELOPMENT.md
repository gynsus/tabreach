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
pnpm package   # apps/desktop/release/mac-arm64/TabReach.app — quick local build, what CI checks
pnpm dist      # TabReach-<version>-arm64.dmg and -x64.dmg in apps/desktop/release/
```

The configuration is `apps/desktop/electron-builder.config.cjs`. Every build gets the Electron fuses (`RunAsNode` off, Node inspector off, ASAR integrity on), the hardened runtime and the icon from `apps/desktop/build/icon.svg`; after changing the SVG, run `pnpm --filter @tabreach/desktop make-icon` and commit `icon.icns`. The packaged app stores data in `~/Library/Application Support/TabReach/` and logs in `~/Library/Logs/TabReach/`; it needs macOS 13 or later.

Without signing credentials a build is **ad-hoc signed**: it runs on the Mac that built it. On another Mac, Gatekeeper refuses it until the user allows it in Privacy & Security. Ad-hoc builds carry `entitlements.adhoc.plist`. It adds `disable-library-validation`, without which the app cannot load Electron's framework (parts signed ad hoc have no Team ID).

### Signing and notarization

The signing mode is chosen from the environment; nothing secret is in the repository:

| Variable | Meaning |
| --- | --- |
| `CSC_LINK` + `CSC_KEY_PASSWORD` | the Developer ID Application certificate as a base64 `.p12` and its password (CI) |
| `CSC_NAME` | or the name of the certificate already in the keychain (a local build) |
| `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | notarization with an App Store Connect API key |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | or with an Apple ID |
| `APPLE_KEYCHAIN_PROFILE` | or a profile saved with `xcrun notarytool store-credentials` |
| `TABREACH_RELEASE=1` | refuse to build unless a certificate and notarization credentials are both present |

With a certificate the app is signed with `entitlements.mac.plist`, which grants only `com.apple.security.cs.allow-jit`. With notarization credentials it is also notarized and stapled right after signing, by `apps/desktop/scripts/notarize.cjs` rather than electron-builder's own notarization: Apple may hold a submission for an hour or more (much longer for a new team's first ones), and `notarytool --wait` gives up on the first dropped connection. The script submits, polls the status every minute with retries for up to `TABREACH_NOTARY_MINUTES` (80 by default), prints Apple's report when the submission is refused, and staples the ticket. `node apps/desktop/scripts/notarize.cjs <file.dmg>` does the same for a DMG. The DMG is signed too.

**Release.** Pushing a tag `v<version>` (or starting the Release workflow by hand) runs `.github/workflows/release.yml` on macOS. It builds the arm64 and the x64 DMG in two parallel jobs with `TABREACH_RELEASE=1`, then notarizes and staples each DMG. Each job checks its app with `codesign --verify`, `spctl --assess` and `stapler validate`; the arm64 job also runs the self-check (the runner is Apple Silicon). On a tag a last job attaches both DMGs to a draft GitHub release. The repository secrets it needs are `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8` (the contents of the `.p8`), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. Set the version in `apps/desktop/package.json` before tagging.

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
                        policy, human tasks), email (IMAP/SMTP, Gmail API, Microsoft sign-in, inbox, replies),
                        AI gateway and providers, research (company and person), AI drafts and draft checks,
                        browser profiles and tasks, forms, LinkedIn, app control (pause, emergency stop),
                        backup and restore, diagnostics bundle, retention, first-run setup
packages/browser-worker Chrome detection and launch check, profiles and sessions, browser tasks with the
                        checkpoint, in-page overlay, form finding and filling, research rendering and the
                        guarded fetch (ADR 027)
packages/adapter-packs  Adapter pack schema, matcher and the bundled packs (ADR 017)
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

Screens: first-run Setup (`#/setup`), Contacts, Companies (with research), Do not contact, Campaigns (editor
with template or AI steps, schedule, approval and checks, dry run, people with version moves, status CSV,
history), Inbox (replies and writing back), Approvals (keyboard queue: A / E / S / R, J / K; checks, facts and
versions), Browser (profiles, sessions, take/return control), Activity (by category), Status (with "Needs
attention" and the diagnostics bundle), Settings (tabs: general, email accounts, AI, contact policy, website
forms, LinkedIn, data — retention and backups).

The landing page for tabreach.com lives in `site/` (static HTML/CSS, English and Russian, no build step; see
`site/README.md`).

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
