# 03 — System Architecture

## Overview

The MVP is a single Electron application on the user's Mac. It runs as four OS processes of its own plus the Chrome instances it launches. There is no server, no Docker, and no persistent network listener (the only listener is the short-lived single-use OAuth loopback redirect on `127.0.0.1` — ADR 016).

```text
+---------------------------------------------------------------------+
|                         Electron application                        |
|                                                                     |
|  +---------------------+        +--------------------------------+  |
|  | Renderer (React UI) |<------>| Main process                   |  |
|  | UI only             |  IPC   | supervisor, windows, tray,     |  |
|  +----------+----------+        | powerMonitor, safeStorage      |  |
|             |                   | broker, MessagePort broker     |  |
|             | MessagePort       +---------------+----------------+  |
|             v                                   | spawns/restarts   |
|  +------------------------------------------+   |                   |
|  | Core (utilityProcess)                    |<--+                   |
|  | domain | SQLite (sole writer) | jobs +   |                       |
|  | scheduler | workflows | policy |         |                       |
|  | approvals | email | research | AI gateway|                       |
|  +--------------------+---------------------+                       |
|                       | MessagePort (browser protocol)              |
|                       v                                             |
|  +------------------------------------------+                       |
|  | Browser worker (utilityProcess)          |                       |
|  | Playwright | profiles | sessions |       |                       |
|  | browser adapters + adapter packs |       |                       |
|  | overlay injection | takeover | resolver  |                       |
|  +--------------------+---------------------+                       |
+-----------------------|---------------------------------------------+
                        | Playwright (CDP over pipe, no TCP port)
                        v
          +------------------------------------+
          | Google Chrome (user-installed)     |
          | app-managed profile directories    |
          | runtime-injected overlay           |
          +------------------------------------+

 Outbound only: AI provider API (user key), Gmail API / IMAP / SMTP,
 websites being researched or contacted.
```

## Processes

### Main process (`apps/desktop/src/main`)

Responsibilities:

- application lifecycle, single-instance lock;
- spawning, health-checking and restarting `core` and `browser-worker` (`utilityProcess.fork`) with bounded restart backoff;
- creating `MessageChannelMain` pairs and handing ports to renderer, core and worker;
- windows, tray/menu, native notifications, focusing Chrome windows on request (tray and notifications planned with Phase 5 human control; not implemented yet);
- `powerMonitor` (suspend/resume/lock) events forwarded to core; optional `powerSaveBlocker` while campaigns are active (keep-awake: planned, Phase 5);
- secret broker: the only process that calls `safeStorage.encryptString/decryptString`;
- OAuth system-browser launch and the ephemeral loopback redirect listener (ADR 016);
- auto-update (post-MVP optional).

Must not:

- contain domain logic;
- read or write the database;
- drive Playwright.

### Renderer (`apps/desktop/src/renderer`)

React UI: prospects, campaigns, approvals queue, inbox, browser sessions, interventions, timeline, settings.

Hardening: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP, no remote content, navigation and `window.open` denied. The preload exposes a minimal typed bridge: `invoke(type, payload)` for queries and commands, `subscribe(eventTypes)`, `onCoreState`, and `saveTextFile` (see `06-API-CONTRACT.md`).

Must not contain channel logic, browser automation, direct provider calls, or its own copy of domain state beyond view caches.

### Core (`packages/core`, utilityProcess)

Responsibilities:

- domain model and SQLite persistence (the only process that opens the database file);
- migrations on startup (after a local recovery backup via the SQLite backup API);
- durable job queue and scheduler (ADR 011);
- workflow orchestration and state machines (`13-WORKFLOW-ENGINE.md`);
- campaigns, enrollments, contact policy, approvals;
- side-effect ledger and action events;
- email channel (Gmail API, IMAP/SMTP), reply ingestion;
- research orchestration and static fetching;
- AI gateway — the single place that calls AI providers, including for the browser worker's semantic resolution;
- dispatching browser tasks to the worker and applying their results.

Core is written as plain Node code with no Electron imports so that it can be tested and run in plain Node. Electron-specific capabilities (secrets, power events) arrive through the main-process port.

### Browser worker (`packages/browser-worker`, utilityProcess)

Host process type: Electron `utilityProcess`, validated in Phase 0 in the packaged, fused app on Apple Silicon (ADR 012; electron/electron#48145 did not reproduce on macOS). Worker code does not depend on `utilityProcess`-specific APIs beyond a thin host adapter (message channel + lifecycle), so the host can be swapped if a future release regresses.

Responsibilities:

- locating the installed Google Chrome and launching it through Playwright `launchPersistentContext` with app-managed profile directories;
- profile ownership lease and session state;
- executing **browser tasks** (high-level units such as `PrepareFormSubmission`, `ExecuteApprovedLinkedInMessage`, `CheckConversationForReplies`, `RenderPageForResearch`);
- browser channel adapters (web form, LinkedIn) driven by adapter packs;
- page-state recognition, challenge detection;
- semantic target resolution client (asks core's AI gateway to choose among enumerated candidates);
- in-page overlay injection and highlighting;
- human-control state and pause handling;
- screenshots and diagnostics.

The worker holds no durable state. Everything durable is reported to core, which persists it. If the worker dies, core marks its in-flight tasks interrupted and the recovery rules of `19-ERROR-RECOVERY.md` apply.

## Where channel logic lives

The channel adapter contract (`14-CHANNEL-ADAPTERS.md`) has two halves:

- **Intent side (core):** capabilities, validation, policy metadata, preparation of content, ledger reservation, result interpretation. Email adapters are entirely in core.
- **Browser side (worker):** for browser channels, the page-level logic (recognize states, locate, fill, click, verify) runs in the worker as browser tasks. Core never sends individual clicks for campaign work.

Low-level `page.*` commands exist only for diagnostics and developer tooling.

## Inter-process communication

All IPC uses `MessagePort`s created by main. There are two protocols defined in `packages/protocol`:

- **App protocol** — renderer ↔ core: commands, queries, event subscription (`06-API-CONTRACT.md`).
- **Browser protocol** — core ↔ worker: browser tasks, task progress/checkpoints, results, session events, AI resolution requests (`07-BROWSER-RUNTIME.md`).

Every message has an envelope:

```json
{
  "id": "019...",
  "kind": "command | query | result | event",
  "type": "browser.task.start",
  "schemaVersion": 1,
  "correlationId": "019...",
  "causationId": "019...",
  "sentAt": "2026-09-28T10:00:00.000Z",
  "payload": {}
}
```

Both sides validate every inbound message with Zod. Unknown `type` or `schemaVersion` is rejected with an explicit error result, never ignored.

Because all processes ship in the same app bundle, protocol versions always match at runtime; `schemaVersion` exists for persisted payloads (jobs, events) and for clear failure on programming errors.

## Persistence

- One SQLite database file in `~/Library/Application Support/TabReach/data/app.db`.
- WAL mode, `foreign_keys=ON`, `busy_timeout` set, `synchronous=NORMAL`.
- Only core opens the file.
- Driver: Node's built-in `node:sqlite` (ADR 011). Schema in `05-DATABASE-SCHEMA.md`; plain-SQL migrations applied by core on startup after an automatic local recovery backup.
- Never copy `app.db` as a plain file while it is open (WAL would be ignored). All backups use the SQLite online backup API or `VACUUM INTO`.

### Two kinds of backup

| | Local recovery backup | Portable export |
|---|---|---|
| Purpose | rollback on the same Mac/user (pre-migration, manual restore point) | move/keep data elsewhere |
| Created | automatically before migrations; manually | only on explicit user action |
| Content | full database | database without the `secrets` table |
| Secrets | `safeStorage` ciphertext only (undecryptable on another Mac/user); never plaintext | none |
| Browser profiles, diagnostics | excluded | excluded |
| Location | `data/backups/` | user-chosen file |

Excluding `secrets` from the pre-migration backup would lose OAuth/AI credentials on rollback; including ciphertext is safe because it is bound to this Mac user's Keychain.

## Filesystem layout

```text
~/Library/Application Support/TabReach/
├── data/app.db                 # SQLite (+ -wal, -shm)
├── data/backups/               # pre-migration and manual backups
├── profiles/{profile-id}/      # Chrome user-data dirs (credential-equivalent)
├── artifacts/screenshots/      # retention-managed
└── artifacts/diagnostics/      # retention-managed
~/Library/Logs/TabReach/ # pino JSON logs, rotated
```

Domain entities store logical references (profile ID, artifact ID), not absolute paths.

## Dependency direction

```text
renderer        -> protocol
main            -> protocol
core            -> protocol, domain interfaces; no Playwright, no Electron
browser-worker  -> protocol, adapter-packs, Playwright; no database
adapter-packs   -> (data + schemas only)
```

Domain code depends on interfaces, never on implementation packages for Playwright, Gmail, IMAP libraries or AI SDKs. Import boundaries are enforced by ESLint `no-restricted-imports` rules per package (`eslint.config.js`).

## Process supervision and failure

- Main restarts a crashed core or worker with exponential backoff (1 s … 30 s; more than 5 crashes in 2 minutes stops retrying). Main tells the window the core state (`starting | running | restarting | failed`); the UI shows a banner while core is not running, requests fail fast instead of waiting for timeouts, and everything is refetched when core returns (ADR 020).
- Quit: main sends SIGTERM to core and worker and waits (bounded, 3 s) so core closes the database cleanly; only then does the app exit.
- Core crash: in-flight jobs keep their lease; on restart, expired leases are reclaimed and recovery runs per job type.
- Worker crash: core marks running browser tasks `interrupted`; Chrome processes launched by the worker are terminated by main if orphaned (Phase 5); a restarted worker removes leftover temporary profiles; recovery per `19-ERROR-RECOVERY.md`.
- Renderer crash: main reloads the window, which reconnects to core. A new core port is handed over only on a real document load of the app page, never on in-app (hash) navigation.
- Sleep: on `suspend`, core stops dispatching new jobs; on `resume`, the scheduler re-evaluates due jobs against campaign windows.

## Why this shape

See ADR 011 (single TypeScript + SQLite stack) and ADR 012 (process topology). In short: the product is local-only and must install as a normal Mac app, so every component that needs a separate runtime, a container or a network port is a cost without a benefit. The process split that remains exists for crash isolation (Chrome/Playwright failures must not take down the database owner) and for keeping Electron-specific code out of testable domain code.
