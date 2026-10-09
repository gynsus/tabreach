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
- SQLite in core: open with pragmas, plain-SQL migrations, pre-migration local recovery backup (backup API), one trivial table;
- secret broker in main (`safeStorage`) with a round-trip test;
- worker: detect installed Chrome, launch and close a test profile (no automation yet);
- pino logging per process with redaction;
- Vitest + Playwright Test wired; CI on macOS (typecheck, lint, test);
- **packaging spike**: `pnpm package` produces a `.app` via electron-builder that starts, runs migrations, launches Chrome; document what signing/notarization needs (certificate, entitlements);
- **SQLite driver spike**: `better-sqlite3` vs built-in `node:sqlite` under Electron and plain Node; record the result in ADR 011 (done: `node:sqlite`);
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

Order (decided in the 4.5 audit, 2026-09-29), each a working slice:

- **5a — protocol, profiles, sessions**: browser tables (`browser_profiles`, `browser_sessions`, `browser_tasks`), profile create/open/close/health/delete with purposes and the research profile, sessions with control modes, heartbeat, crash handling and orphan Chrome cleanup, profiles UI. Exit: log into a fixture site manually, restart, session preserved.
- **5b — adapter packs and page states**: pack format, loader and schema validation, allowlist state matching, deterministic primitives inside tasks, diagnostics, challenge detection and `human_interventions`. Exit: fake CAPTCHA → `WAITING_FOR_HUMAN`.
- **5c — overlay and human control**: overlay (pause only), take/return control, revalidation, outcome confirmation, the `about_to_commit` checkpoint; app-wide **Pause all** and **Emergency stop** (docs/11, FR-BRA-008) and **keep-awake** (FR-APP-004); tray and native notifications for interventions. Exit: automation blocked during human control; worker crash after `about_to_commit` → `unknown`.
  - **5c-1 (done 2026-09-29)**: overlay (pause only), take/return control with re-check, Pause all / Emergency stop / keep-awake, tray and notifications.
  - **5c-2 (done 2026-09-29)**: the `about_to_commit` checkpoint, a critical browser action through the side-effect ledger, worker crash after the checkpoint → `unknown`, outcome confirmation.
- **5d — browser research (done 2026-09-29)**: `RenderPageForResearch` in the research profile for pages the static fetcher cannot read (ADR 027).
- **Audit 5.5 (2026-09-29)**: three independent reviews (security, side effects and workflows, rules/docs/UI). Fixed: research render and static fetch pinned to checked addresses, redirects checked hop by hop, IPv4-in-IPv6 forms, cookies not sent or kept, context-wide routing, no downloads or WebRTC around the guard; `commit` re-checks the page and presses the element it recognized; stored URLs without query strings; masked screenshots and 30-day diagnostics retention; one task per session and `task.cancel`; orphan windows closed; sign-in check ends on give-up and on a profile the person opened, requests settled once; research rendering respects pause and recovers from an emergency stop; a job still running after a Mac sleep is not claimed twice; translations for every error key and job type; stale docs. Carried to Phase 6: when `BrowserActionChannel` is wired to a campaign channel, `needs_human` and `user_control` results must put the run in `WAITING_FOR_HUMAN` with an intervention (today the channel leaves the window to the person and reports `not_sent`, which the engine would retry); values filled into a form before a refused checkpoint have been seen by the page (inherent; documented); the tray follows the system language, not the interface language.

---

## Phase 6 — Website form channel

Also: per-contact channel eligibility (`contact_channel_eligibility`, docs/01, docs/05), needed once a contact can be reached by more than email.


Deliver:

- contact-page discovery and field mapping (pack heuristics + AI assistance);
- `PrepareFormSubmission` / `ExecuteFormSubmission` with approval payload preview and screenshot;
- semantic target resolution via the gateway (ADR 013), bounded;
- verification or `unknown`; user confirmation path.

Order, each a working slice:

- **6a — worker and forms (done 2026-09-29)**: the `web-form` pack, `form.prepare` / `form.submit` with discovery, heuristic mapping, consent never ticked, screenshot, checkpoint, verification; form fixtures.
- **6b — the campaign channel (done 2026-09-29)**: the sender's details for forms, `web_form` message steps, a PREPARE_FORM state before approval (the approval shows the exact fields and a photo of the form), sending through the ledger, eligibility, UI, E2E. A person is needed for a challenge, an unknown required field or a required consent: the form becomes `assisted` and is approved again (the person presses Send); taken control or a window the person holds makes the send wait. There is no `WAITING_FOR_HUMAN` state for campaign steps (the carried audit 5.5 item is solved this way).
- **Audit 6.5 (2026-09-29)**: two independent reviews (security; workflows). Fixed: the step's `executionMode` is honoured; the final pre-send checks run again at the checkpoint (a stop, reply, pause or edit that arrives while the form is filled means nothing is pressed); nothing is typed into the site before approval (the approval shows values in the app and a photo of the empty form); success needs a success text new since the press, a refusal needs a new visible error seen twice with the values intact and only in `auto` — anything less is `unknown`; stricter honeypot detection (off-screen, transparent, clipped, `aria-hidden`); a consent the page ticked is unticked and shown; the form's action and the page's own values are in the signature and the approval (a cross-site action is never auto-approved); comment forms and submit buttons of other forms are not ways in; redirects off the company's site refused; websites in the local network never opened; one form per company per campaign step; another sender re-prepares waiting forms; an archived sender profile stops instead of waiting silently, and the sender profile cannot be archived or deleted; a form that keeps changing goes to the person after three preparations; screenshots kept for the latest preparation, 30 days; one send at a time per channel account while email goes on beside a waiting form. Carried: recording what the person changed in assisted mode; an assisted form never pressed ends `unknown`; the review window left paused after an `unknown` holds further form sends until it is closed (said in Unconfirmed sends).
- **6c — semantic resolution (done 2026-09-29)**: `ai.resolveTarget` (ADR 013) for fields the phrases do not recognize and changed layouts; bounded, recorded, never the submit button in `auto`.

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

Order, each a working slice:

- **7a — worker and pack (done 2026-09-29)**: LinkedIn pack 0.2.0 (profile, invitation, message and conversation states in English and Russian; connect, connect with a note, message; the thread reader; identity rule; default throttles), `commit` steps and identity checks, `thread.read`, LinkedIn-like fixtures.
- **7b — the campaign channel (done 2026-09-29)**: LinkedIn account on a channel-identity profile, kill switch (fails closed) and risk notice, `linkedin` connect/message steps (assisted by default, auto only by opt-in per action class), the mandatory conversation check before follow-ups, per-account throttles, pack version on every action.
- **7c — visibility and polish (done 2026-09-30)**: `unsupported_state` rate per pack version, UI, E2E, docs.

Exit criteria:

- adapter can be disabled globally (fails closed);
- unsupported page state never triggers blind clicking;
- follow-up is not sent when the fixture thread contains a new reply;
- critical action requires configured policy; all attempts logged with pack version.

Automated tests use fixture pages only; real LinkedIn is checked manually by the developer.

Exit criteria status (2026-09-30): the adapter is off by default and when its setting cannot be read, and the switch is checked again at the checkpoint (core tests); an unrecognized page or a page about someone else is never clicked (browser tests on fixtures with the bundled pack); a follow-up is not sent when the thread has a new answer (browser and core tests); `auto` needs the per-class opt-in and every attempt is a `browser_tasks` row with its pack version, summarized per version on the status screen. Real pages (2026-10-09): profile recognition, identity, the conversation page, the thread reader, the message composer and the invitation dialog were checked on real LinkedIn up to the press and the pack corrected (0.5.0, docs/14). `manual` (2026-10-09): LinkedIn steps can be `manual` — the page is opened and checked, the text shown in the overlay with a Copy button, and the person confirms the outcome (ADR 015).

---

## Phase 8 — Hardening and release

Progress: 8a-1 recovery scenarios from docs/19 each covered by a test, and a guard against two concurrent attempts at one browser send (done 2026-10-09); 8a-2 sanitized diagnostics bundle (done 2026-10-09, docs/20).

Deliver:

- all recovery scenarios from `19-ERROR-RECOVERY.md` tested;
- sanitized diagnostics bundle;
- retention settings and job;
- local recovery backup/restore and portable export (without secrets);
- first-run setup wizard (Chrome check, AI key, email account, first profile);
- MVP items found unassigned by the 4.5 audit (docs/01): campaign clone and dry-run preview (FR-CAM-001, FR-CAM-008); campaign status CSV export (FR-PROS-007); manual reply drafting from the inbox; XOAUTH2 for IMAP/SMTP; threaded email follow-ups (`In-Reply-To`/`References`, docs/17 `replyAsThread`); campaign goal, ICP and research instructions, campaign batch and contact-level research, research freshness per campaign (FR-RES-001, docs/16); evidence text with the quote highlighted (FR-RES-005); per-campaign AI budget and cost; the remaining step types (`wait`, `human_task`, `webhook` — the last needs a decision against CLAUDE.md §1's outbound-traffic rule);
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
