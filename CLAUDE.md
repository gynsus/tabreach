# CLAUDE.md — Development Contract for TabReach

This file is the highest-priority project instruction for Claude Code.

## 1. Mission

Build the MVP described in `docs/` as a production-quality **local-only desktop application**. Do not redesign the product opportunistically. If an implementation detail is ambiguous, prefer the documented architecture and add an ADR for any material deviation.

The product is installed on the user's own Mac and works locally. There is no cloud control plane, no SaaS backend and no multi-user server — now or as a planned direction. The only outbound network traffic is to sites the user works with, to AI/email providers the user configured, and (optionally) to update feeds.

The project is browser-first: the browser runtime is a core subsystem. The MVP uses the user's installed standard Google Chrome with dedicated, app-managed profiles, not a custom Chromium fork.

## 2. Mandatory reading order

Before changing code, read:

1. `README.md`
2. `docs/00-PRODUCT-VISION.md`
3. `docs/01-MVP-SCOPE.md`
4. `docs/03-SYSTEM-ARCHITECTURE.md`
5. `docs/22-IMPLEMENTATION-PLAN.md`
6. the specific subsystem documents related to the task;
7. all relevant `docs/adr/*.md` (superseded ADRs are kept for history; follow the superseding one).

Do not implement from this file alone.

## 3. Non-negotiable architectural rules

### 3.1 Single stack, process layering

One language: TypeScript. One database: SQLite (single file, owned by one process). See ADR 011 and ADR 012.

- `apps/desktop` — Electron main process (supervisor, windows, tray, power events, secret broker via `safeStorage`) and the React renderer. The renderer is UI only. Main is a supervisor and broker, not a backend.
- `packages/core` — runs in an Electron `utilityProcess`. Owns domain state, SQLite persistence, job queue and scheduler, workflow orchestration, policy, approvals, campaigns, email channel, research orchestration and the AI gateway. It is the **only** writer to the database.
- `packages/browser-worker` — runs in a separate Electron `utilityProcess` (validated in Phase 0, ADR 012), behind a thin host adapter so the host type stays swappable. Owns Chrome processes, profiles, sessions, Playwright, browser channel adapters (web forms, LinkedIn), the semantic resolver client, the in-page overlay and human-takeover coordination. It has **no** database access; it reports results to core.
- `packages/protocol` — message envelopes, Zod schemas and types for all inter-process messages. The only package shared by all processes.
- `packages/adapter-packs` — versioned, schema-validated data definitions for browser adapters (page-state recognizers, locators, verification checks, default limits).

Forbidden imports (enforced by lint): `core` must not import Playwright; `browser-worker` must not import the database layer; the renderer imports only `protocol` and UI code.

### 3.2 No channel leakage

Campaign logic must not contain code such as:

```text
if channel == "linkedin" then click(...)
```

Campaigns emit intent. Channel adapters translate intent into actions.

### 3.3 Deterministic first, AI second

For known workflows:

1. deterministic Playwright action driven by an adapter pack;
2. bounded semantic target resolution (ADR 013) — the model chooses from a closed candidate list, the click itself stays deterministic;
3. human takeover if confidence or safety is insufficient.

Never use an LLM for every click when a deterministic state is available. Semantic resolution never selects the final target of a critical action in `auto` mode.

### 3.4 State machines, not linear scripts

Any workflow that can interact with an external site must be resumable after:

- app restart;
- Mac sleep/wake;
- browser restart or crash;
- network failure;
- human takeover;
- authentication expiry;
- CAPTCHA/2FA/security challenge;
- unexpected modal;
- selector failure.

Persist workflow state before and after meaningful side effects. The state machine ownership map in `docs/13-WORKFLOW-ENGINE.md` is authoritative.

### 3.5 Side-effect safety

Before a critical action such as sending an email, sending a browser message, submitting a form, or sending a connection request:

- resolve the current approval policy and execution mode;
- run contact-policy checks (suppression, frequency caps, stop conditions) at send time;
- verify target identity;
- verify message/content hash against the approval;
- reserve the side-effect ledger entry keyed by **logical intent** (never by content hash — ADR 018);
- write a `planned` action event;
- execute only when permitted;
- verify the resulting external state;
- write `completed`, `failed` or `unknown`. `unknown` is never auto-converted to `completed` and never auto-retried.

Default policy: `approve_each`.

### 3.6 Adapters act only in recognized states

A browser adapter may act only when the current page positively matches an expected state from its adapter pack. Anything unrecognized is `UNSUPPORTED_STATE`. Challenge detection is an additional signal, not the safety mechanism.

### 3.7 CAPTCHA and security challenges

Never implement automated CAPTCHA solving, stealth bypasses, credential theft, or attempts to defeat account-security controls.

When a challenge is detected:

```text
RUNNING -> WAITING_FOR_HUMAN
```

Create a human-intervention request and surface the browser session.

### 3.8 No anti-detect/fingerprint spoofing

The product uses legitimate dedicated browser profiles. Do not add fingerprint spoofing, stealth plugins, `navigator.webdriver` patching, proxy rotation intended to evade platform controls, or hidden bot-evasion features.

### 3.9 Evidence and provenance

Every AI-generated research finding used for qualification or personalisation must have:

- source URL;
- source title where available;
- a verbatim quote that is programmatically verified to exist in the captured evidence text;
- timestamp;
- extractor method;
- optional confidence.

Do not generate unsupported research facts.

### 3.10 Secret handling

- Never commit real API keys or OAuth client secrets.
- Never log access tokens, refresh tokens, session cookies, API keys or passwords.
- Store secrets encrypted with Electron `safeStorage` (Keychain-backed on macOS). Only the main process can encrypt/decrypt; core requests secrets through the main-process broker.
- Browser profile directories are credential-equivalent and must not be copied into logs, fixtures, diagnostics bundles or bug reports.

### 3.11 No persistent network listeners

The app exposes no persistent application HTTP/WebSocket listeners. Inter-process communication uses Electron `MessagePort`s (or the equivalent IPC channel of the chosen worker host). The only exception is a short-lived, single-use OAuth loopback listener bound to `127.0.0.1` during an authorization the user started (ADR 016).

### 3.12 No exactly-once promises

External side effects without provider idempotency cannot be guaranteed exactly-once. The guarantee is: **never an automatic duplicate**. An uncertain outcome is reconciled to `completed` or `not_sent`, or stays `unknown` and is surfaced to the user; `unknown` is never automatically re-executed.

## 4. Technology baseline

Unless an ADR changes it:

- TypeScript, `strict: true`, pnpm workspaces
- Electron (current stable); core and browser worker in `utilityProcess` (ADR 012)
- React + TypeScript + Vite (electron-vite)
- SQLite via Node's built-in `node:sqlite`; plain-SQL migrations with core's own runner, no ORM (ADR 011)
- Zod for all process-boundary validation
- Playwright (library) driving the user's installed Google Chrome (`channel: 'chrome'`); Playwright Chromium for tests/fixtures
- pino for structured logs
- Vitest for unit/integration tests; Playwright Test for fixture and Electron E2E tests
- electron-builder for packaging, hardened runtime and notarization

Not used: PHP, Symfony, PostgreSQL, Redis, RabbitMQ, Docker, Stagehand, Chrome extension, native Node modules.

Pin exact versions in lockfiles. Do not put floating `latest` versions in manifests.

## 5. Coding rules

- No pseudocode committed as implementation.
- No empty TODO methods in merged code.
- Prefer explicit domain types over stringly typed maps; discriminated unions for events/commands.
- No `any` without a documented justification.
- Database migrations are mandatory for schema changes.
- Public interfaces need tests.
- External APIs (AI providers, Gmail, IMAP/SMTP) must be wrapped behind interfaces/adapters.
- Retries require bounded retry policy and backoff.
- Every retrying operation must be idempotent or explicitly non-retryable.
- Do not silently catch exceptions.
- Use structured logs with correlation IDs.
- Every long-running operation supports timeout and cancellation (`AbortSignal`).

## 6. Testing rules

Each implementation slice must include what is applicable:

- unit tests for domain logic;
- integration tests against a real SQLite file (temporary directory), including migrations;
- protocol contract tests for inter-process messages;
- browser tests using controlled local fixture pages;
- regression test for every fixed browser workflow bug when feasible.

Do not add test types that have nothing to test in the current slice.

Never rely on live LinkedIn, Gmail or third-party production websites in automated CI.

## 7. Change discipline

For each meaningful task:

1. read relevant docs;
2. describe the intended change in the task/commit message;
3. implement the smallest coherent vertical slice;
4. run relevant tests;
5. update docs when behaviour/contracts change;
6. add/update ADR when architecture changes.

Do not perform broad refactors unrelated to the active implementation phase.

## 8. Definition of done

A task is done only when:

- code type-checks and builds;
- migrations run on an empty and on the previous-version database;
- tests pass;
- no secrets are present;
- error handling exists;
- observability exists for new external side effects;
- docs are updated;
- acceptance criteria for the slice are demonstrably met.

## 9. Product boundaries

MVP includes:

- prospects;
- research with evidence;
- campaigns/sequences;
- email (Gmail API with user-owned OAuth client; generic IMAP/SMTP);
- generic web forms;
- browser-assisted LinkedIn adapter (`assisted` execution mode by default);
- managed browser profiles;
- approvals and execution modes (`auto`, `assisted`, `manual`);
- contact policy: suppression, frequency caps, stop conditions;
- inbox/reply classification for email, reply check before LinkedIn follow-ups;
- human takeover;
- action timeline and evidence.

MVP excludes:

- cloud control plane / SaaS / sync;
- billing, licensing, teams/RBAC;
- cloud browser fleet;
- CAPTCHA solving;
- anti-detect;
- proxy marketplace;
- Chrome extension;
- recorder / teach mode;
- arbitrary universal RPA builder;
- custom Chromium fork;
- autonomous unrestricted web actions;
- SMS/voice/WhatsApp;
- full CRM replacement.

See `docs/24-OUT-OF-SCOPE.md`.

## 10. When implementation and docs conflict

Stop the local change, inspect relevant ADRs, and preserve the documented invariants. If a deviation is necessary, create an ADR explaining:

- context;
- decision;
- alternatives;
- consequences;
- migration impact.

Do not silently redefine the architecture.
