# TabReach

A local-only, browser-first desktop application for controlled research, personalisation, email outreach, website-form outreach, and browser-assisted channel actions (LinkedIn).

## Product thesis

The browser is a first-class runtime, not a collection of ad-hoc Playwright scripts.

The MVP combines:

- a desktop application (Electron) that is the whole product — no server to deploy;
- the user's installed Google Chrome driven through dedicated, app-managed persistent profiles;
- deterministic browser automation through Playwright, driven by versioned adapter packs;
- bounded AI-assisted target resolution and research;
- a resumable, SQLite-backed workflow/state-machine engine;
- email and browser channel adapters;
- research with evidence and verified quotes;
- human approval, assisted execution and human takeover;
- complete action/event logging.

The MVP does **not** depend on a custom Chromium fork.

## MVP target

- single user, installed locally, works locally — permanently (no SaaS direction);
- macOS first (Apple Silicon primary); Windows later is kept cheap by the stack choice but is not an MVP goal;
- installable as a signed, notarized `.app` without Docker or other prerequisites except Google Chrome;
- user brings their own AI provider API key;
- Gmail via the user's own Google OAuth client, plus generic IMAP/SMTP;
- generic website contact forms;
- LinkedIn as an isolated browser adapter, `assisted` execution mode by default;
- default `approve_each` for critical actions;
- `approve_campaign` available as an explicit mode with automated draft checks;
- CAPTCHA, 2FA and account challenges always stop automation and require human intervention.

## Repository shape

```text
tabreach/
├── apps/
│   └── desktop/                # Electron main + preload + React renderer, packaging
├── packages/
│   ├── protocol/               # IPC envelopes, Zod schemas, shared types
│   ├── core/                   # domain, SQLite, jobs/scheduler, workflows, policy, email, research, AI gateway
│   ├── browser-worker/         # Playwright, profiles, sessions, browser adapters, overlay, takeover
│   └── adapter-packs/          # versioned data definitions for browser adapters
├── fixtures/
│   └── sites/                  # local fixture web apps for browser tests
├── docs/
│   ├── adr/
│   └── ...
├── CLAUDE.md
└── README.md
```

## Read first

Claude Code must read, in order:

1. `CLAUDE.md`
2. `docs/00-PRODUCT-VISION.md`
3. `docs/01-MVP-SCOPE.md`
4. `docs/03-SYSTEM-ARCHITECTURE.md`
5. `docs/22-IMPLEMENTATION-PLAN.md`
6. the document for the subsystem being changed;
7. relevant ADRs under `docs/adr/`.

The revision rationale of 2026-09-28 is in `docs/REVISION-NOTES-2026-09-28.md`.

## Architectural invariants

1. Browser code never lives inside campaign/domain services; Playwright is imported only by `browser-worker`.
2. Channel-specific behaviour must be behind channel adapters.
3. Browser workflows are resumable state machines.
4. LLM output is never treated as trusted executable instruction; semantic resolution picks from a closed candidate set.
5. Critical external actions require policy evaluation and, by default, explicit human approval.
6. Browser adapters act only in positively recognized page states.
7. CAPTCHA/2FA/security challenges are never bypassed automatically.
8. Secrets are never stored in Git, logs, screenshots or prompts.
9. Every externally visible action produces an auditable action event and a side-effect ledger entry keyed by logical intent.
10. Research claims keep source/evidence references with verified quotes.
11. Failures preserve enough evidence to reproduce them without silently retrying forever.
12. The app exposes no persistent network listeners; the only exception is a short-lived single-use OAuth loopback listener on `127.0.0.1`.
13. No exactly-once promises: uncertain side effects are never automatically repeated.

## Development command goal

By the end of Phase 0, a clean macOS checkout should be bootstrappable with:

```bash
pnpm install
pnpm dev
```

and a local unsigned `.app` build with:

```bash
pnpm package
```

Exact commands may evolve, but onboarding must remain near-one-command and fully documented in `docs/DEVELOPMENT.md`.

## Status

Implemented phase by phase according to `docs/22-IMPLEMENTATION-PLAN.md`. As of 2026-09-29, Phases 0–6 and the 1.5, 3.5, 4.5 and 5.5 audits are done:

- prospects, CSV import/export and the do-not-contact list;
- campaigns with versions, schedules in the recipient's time zone, contact policy and a keyboard approval queue;
- email through IMAP/SMTP or the Gmail API with the user's own OAuth client, without automatic duplicates, with replies and bounces stopping sequences;
- the AI gateway with the user's key (Anthropic, OpenRouter, OpenAI), research with verified quotes, reply labels and AI drafts with automated checks and `approve_campaign`;
- timelines of every contact, company and campaign;
- managed Chrome profiles, page recognition by adapter packs, challenges handed to the person, the in-page overlay, take/return control, Pause all and Emergency stop, the `about_to_commit` checkpoint for critical browser actions, and JavaScript-only sites rendered for research.;
- website contact forms as a campaign channel: the form found and filled before approval, the approval showing exactly what goes in, sending through the checkpoint, the person pressing Send when a CAPTCHA, a consent or an unknown required field needs them, and AI recognizing unfamiliar fields from a closed list.

Next: Phase 7, the LinkedIn adapter.
