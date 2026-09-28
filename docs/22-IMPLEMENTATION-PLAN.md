# 22 — Implementation Plan

Implement in phases. Each phase ends in a working vertical slice.

Ordering principle (revision 2026-09-28): prove the core loop — prospect → workflow → approval → safe side effect → verified result → reply → stop — first on the cheapest reliable channel (email), then add the browser, then LinkedIn. Packaging risk is retired in Phase 0, not at the end.

Do not start LinkedIn before the workflow engine, approvals, side-effect ledger, browser worker and human control are stable.

---

## Phase 0 — Repository, process skeleton and packaging spike

Deliver:

- pnpm monorepo: `apps/desktop`, `packages/protocol`, `packages/core`, `packages/browser-worker`, `packages/adapter-packs`, `fixtures/sites`;
- TypeScript strict, ESLint, Prettier, import-boundary rules;
- Electron app with main, preload, renderer (React), core `utilityProcess`, worker in an isolated process behind a thin host adapter;
- MessagePort wiring and the protocol envelope with Zod validation; `health` messages end to end;
- SQLite in core: open with pragmas, drizzle migrations, pre-migration local recovery backup (backup API), one trivial table;
- secret broker in main (`safeStorage`) with a round-trip test;
- worker: detect installed Chrome, launch and close a test profile (no automation yet);
- pino logging per process with redaction;
- Vitest + Playwright Test wired; CI on macOS (typecheck, lint, test);
- **packaging spike**: `pnpm package` produces a `.app` via electron-builder that starts, runs migrations, launches Chrome; document what signing/notarization needs (certificate, entitlements);
- **native module spike**: `better-sqlite3` under Electron and under plain Node for tests (or `node:sqlite`); record the result in ADR 011;
- **packaged browser-worker spike — do this first, before building anything around it**: in the packaged, signed-or-ad-hoc-signed `.app` on Apple Silicon macOS, the worker (as `utilityProcess`) launches installed Chrome via Playwright with a persistent profile, runs `page.goto('https://example.com')`, waits for load, reads the title, closes; repeats after an app restart. If it fails, try the fallback hosts in ADR 012 in order and record the choice, including the `RunAsNode` fuse consequence;
- `docs/DEVELOPMENT.md`.

Exit criteria:

- clean checkout: `pnpm install && pnpm dev` shows a status screen with core, worker, DB and Chrome health;
- packaged `.app` starts on a clean Mac user account;
- lint/typecheck/tests pass without TODO stubs.

---

## Phase 1 — Prospects and audit foundation

Deliver:

- migrations for companies, contacts, profile URLs, tags, suppressions, action events, settings;
- company/contact CRUD;
- CSV import preview/commit, export;
- dedupe rules;
- suppression list UI + CSV import;
- action event foundation and timeline component.

Exit criteria:

- import a CSV, inspect/edit, export;
- duplicate import handled predictably;
- suppression entries visible and searchable.

---

## Phase 2 — Workflow engine, approvals and contact policy

Deliver:

- `jobs` table, dispatcher, leases, backoff, dead jobs, needs-attention view;
- workflow runs/step runs and the state machine framework with the ownership rules;
- `side_effects` ledger with logical-intent keys and reconciliation hooks;
- campaigns, versions, steps (with execution modes), enrollments, scheduler (timezones, windows, catch-up), pause/resume;
- contact policy checks (suppression, frequency caps, stop conditions);
- message drafts (manual text for now), content hash, approvals (`approve_each`), batch approval queue;
- a **test channel adapter** (records "sent" into a local table) to exercise the full loop without external systems;
- powerMonitor integration (suspend/resume).

Exit criteria:

- a campaign with test-channel steps runs over multiple prospects with delays;
- restart the app mid-run and it resumes;
- simulated crash between `executing` and result yields `unknown`, not a duplicate;
- edited draft invalidates approval;
- suppressed contact is blocked at send time.

---

## Phase 3 — Email channel

Deliver:

- `EmailTransport` interface; IMAP/SMTP transport; Gmail API transport with user-owned OAuth client and setup wizard (External and Workspace Internal branches, scope-class explanation);
- OAuth loopback flow in main (PKCE, state, single use);
- app-generated `Message-ID`, Sent reconciliation;
- reply ingestion (polling), reply matching, bounces, conversations/messages, inbox UI;
- stop-on-reply (contact and company level);
- per-account limits and spacing.

Exit criteria:

- a forced crash around email submission never causes an automatic duplicate: the send is reconciled to `completed`/`not_sent` or stays `unknown` and is surfaced;
- reply appears in inbox and stops the sequence;
- bounce marks the address and stops;
- no token or password appears in DB (outside `secrets`), logs, events or diagnostics.

This is the first phase delivering real outreach value (manually written or templated emails).

---

## Phase 4 — AI gateway, research and drafting

Deliver:

- AI gateway with provider interface, Anthropic provider, BYOK key setup, budgets, usage/cost recording;
- prompt template versioning;
- research runs: static fetch, extraction, evidence, facts with quote verification, qualification, evidence UI;
- AI-personalised drafts using facts; draft checks; revision history;
- `approve_campaign` with sample review and automated checks;
- reply classification (incl. opt-out → suppression);
- prompt-injection tests.

Exit criteria:

- research a fixture company; every fact has a verified quote;
- an unsupported fact cannot appear as sourced;
- drafts reference only supplied facts; grounding check catches an injected unsupported specific;
- usage/cost visible.

---

## Phase 5 — Browser worker foundation and human control

Deliver:

- browser protocol (tasks, checkpoints, results, session events);
- profiles (create/open/close/health/delete), purposes, research profile;
- sessions with control modes, heartbeat, crash handling and orphan cleanup;
- adapter-pack format, loader, schema validation, state matching (allowlist);
- deterministic action primitives inside tasks; diagnostics;
- in-page overlay (context, highlight, pause, assisted/manual panels);
- take control / return control / revalidation / user outcome confirmation;
- challenge detection framework;
- `RenderPageForResearch` task wired into research;
- fixture site.

Exit criteria:

- create profile, log into a fixture site manually, restart preserving session;
- fake CAPTCHA transitions to `WAITING_FOR_HUMAN`;
- automation blocked during human control; overlay can only pause;
- worker crash after `about_to_commit` yields `unknown` and reconciliation, never a repeat.

---

## Phase 6 — Website form channel

Deliver:

- contact-page discovery and field mapping (pack heuristics + AI assistance);
- `PrepareFormSubmission` / `ExecuteFormSubmission` with approval payload preview and screenshot;
- semantic target resolution via the gateway (ADR 013), bounded;
- verification or `unknown`; user confirmation path.

Exit criteria:

- works against all form fixture variants;
- changed locator recovers through semantic resolution or goes to human;
- CAPTCHA fixture never auto-submits.

---

## Phase 7 — LinkedIn adapter

Prerequisite: phases 2, 5 and 6 stable.

Deliver:

- LinkedIn adapter pack (states, locators incl. UI-language variants, verification, default limits);
- open profile, identity verification, connect, message, follow-up;
- mandatory conversation check before follow-ups;
- `assisted` default, `manual`, opt-in `auto`;
- per-account limits and spacing;
- kill switch and risk notice;
- `unsupported_state` rate per pack version visible.

Exit criteria:

- adapter can be disabled globally (fails closed);
- unsupported page state never triggers blind clicking;
- follow-up is not sent when the fixture thread contains a new reply;
- critical action requires configured policy; all attempts logged with pack version.

Automated tests use fixture pages only; real LinkedIn is checked manually by the developer.

---

## Phase 8 — Hardening and release

Deliver:

- all recovery scenarios from `19-ERROR-RECOVERY.md` tested;
- sanitized diagnostics bundle;
- retention settings and job;
- local recovery backup/restore and portable export (without secrets);
- first-run setup wizard (Chrome check, AI key, email account, first profile);
- signing, notarization, DMG;
- optional: auto-update feed;
- user docs.

Exit criteria:

All `23-ACCEPTANCE-CRITERIA.md` pass on a clean installation of the packaged app.

---

## Post-MVP candidates

- publisher-owned verified Gmail OAuth client (ADR 016, option C) — research verification/assessment cost first;
- signed remote adapter-pack updates;
- full LinkedIn inbox sync;
- Microsoft Graph adapter;
- recorder / teach mode producing adapter packs;
- Windows build;
- local LLM provider.

---

## Implementation discipline for Claude Code

For each phase:

1. create a checklist task file if useful;
2. implement schema/contracts first;
3. implement one vertical path;
4. add tests;
5. update docs;
6. run all relevant tests;
7. do not start next phase with known critical failures.

Do not merge large speculative abstractions before they are needed by the current or next immediate phase.
