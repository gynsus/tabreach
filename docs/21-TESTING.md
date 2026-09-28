# 21 — Testing Strategy

## Principles

- Test domain behaviour without third-party sites.
- Browser tests use local fixture sites.
- External providers (AI, Gmail, IMAP/SMTP) are tested through fakes behind their interfaces, plus opt-in manual checks.
- Every regression gets a test when practical.
- Test types are added when the slice has something for them to test — no empty placeholder suites.

## Tooling

- Vitest for unit and integration tests (core, worker logic, protocol).
- Vitest (`*.browser.test.ts`) for fixture-site browser tests with the installed Chrome; Playwright Test for Electron E2E (`_electron.launch`) on the built, unfused app.
- `TabReach --self-check[=url]` for the packaged, fused app, where automation cannot attach.
- Real SQLite files in temporary directories for integration tests (no mocks of the database).
- A local fake SMTP/IMAP server for email integration tests (e.g. a lightweight in-process server); fake Gmail API via recorded/stubbed HTTP.
- A fake AI provider returning scripted structured outputs.

SQLite uses Node's built-in `node:sqlite`, so the same code runs under plain Node in tests and under Electron in the app without native rebuilds (ADR 011).

## Test pyramid

### Unit

- domain rules;
- campaign validation and scheduling (timezones, windows, catch-up);
- approval hashing and invalidation;
- idempotency key derivation (content changes must not change the key);
- workflow state transitions and ownership rules;
- retry classification;
- contact policy (suppression, caps, company-level stop);
- draft checks and quote verification;
- adapter-pack schema validation and state matching;
- log redaction.

### Integration

- migrations (empty DB and previous-version DB);
- job queue: enqueue-in-transaction, claim, lease expiry recovery, backoff, dead jobs;
- side-effect ledger reconciliation paths;
- email transports against fake servers (Message-ID reconciliation, bounce parsing, reply matching);
- protocol contract tests: every message type round-trips through Zod schemas on both sides;
- core ↔ worker with a real worker and fixture sites.

### Browser fixture tests

Local fixture site (`fixtures/sites`) with states for:

- normal contact form;
- dynamic (JS-rendered) form;
- form with required unmapped field;
- modal;
- success page / success inline message / no confirmation (→ `unknown`);
- validation error;
- login screen;
- fake CAPTCHA marker/challenge page;
- changed layout (pack locator fails → semantic resolution → verified);
- ambiguous target (→ human);
- LinkedIn-like fixture: profile, connect dialog, messaging thread with/without new inbound reply, pending invitation, login wall, security check — minimal representative markup, no copied proprietary HTML;
- prompt-injection text on pages.

Tests verify deterministic paths, the allowlist behaviour and semantic resolution boundaries.

### End-to-end (packaged-like app)

```text
import prospect
-> research fixture company
-> generate draft (fake AI)
-> approval
-> browser fill fixture form
-> submit
-> verify
-> timeline
```

and

```text
campaign with email step (fake SMTP/IMAP)
-> send
-> reply arrives
-> sequence stops
```

Real Gmail/LinkedIn checks are manual, run by the developer with an explicit command, never in CI.

## Security tests

- renderer cannot access Node APIs; preload exposes only the bridge;
- invalid/unknown IPC messages rejected;
- overlay binding ignores everything except `pause_requested`;
- plaintext secrets never appear in logs, action events, diagnostics bundles, backups or exports; portable exports contain no `secrets` table;
- prompt-injection fixture cannot cause a side effect or change a draft's recipient;
- human control mode rejects automation actions;
- OAuth loopback listener rejects wrong `state` and closes after use.

## Recovery tests

Mandatory scenarios listed in `19-ERROR-RECOVERY.md`.

## Performance targets for MVP

- list views under ~200 ms for 10k prospects;
- UI responsive during background jobs (no work on main process);
- browser protocol dispatch under ~50 ms excluding page/network work;
- no unbounded memory growth in core over a 24 h fixture campaign run.

## Test commands

Canonical commands (documented in `docs/DEVELOPMENT.md`):

```bash
pnpm test          # unit + integration
pnpm test:browser  # fixture-site browser tests
pnpm test:e2e      # Electron E2E
pnpm check         # typecheck + lint + all tests
```

CI runs on a macOS runner.
