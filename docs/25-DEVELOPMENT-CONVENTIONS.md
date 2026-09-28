# 25 — Development Conventions

## Repository

pnpm monorepo with clear process boundaries (`03-SYSTEM-ARCHITECTURE.md`).

- `packages/protocol` is the single source of truth for inter-process messages: Zod schemas, inferred types, envelope helpers.
- Database schema types (Drizzle) stay inside `packages/core`; they are never imported by the renderer or the worker. The renderer receives DTOs defined in `protocol`.
- Import boundaries are enforced by lint.

## TypeScript

- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`;
- no `any` without documented justification;
- Zod validation at every process boundary and for all persisted JSON columns on read;
- discriminated unions for events, commands, workflow states and results;
- explicit timeout and cancellation (`AbortSignal`) for I/O;
- `Result`-style returns for expected domain failures; exceptions for programming errors and unexpected I/O failures;
- ESM throughout.

## Core code structure

- domain modules (prospects, policy, campaigns, workflows, approvals, email, research, ai) with services independent of transport;
- repositories wrap Drizzle; domain services never build SQL directly;
- no Electron imports in `packages/core` (enforced by lint), so core runs in plain Node for tests.

## Worker code structure

- adapters = state machines over adapter packs;
- Playwright access only through a thin session/page abstraction that enforces control mode checks before each action;
- no database or provider SDK imports.

## Adapter packs

- JSON (or TS-authored and compiled to JSON) validated by a Zod schema in `packages/adapter-packs`;
- semantic versioning; every change to a pack bumps its version;
- each pack has fixture tests;
- packs contain data only (states, locators, verification rules, limits, locale strings) — no executable code.

## IDs

UUIDv7 for all entities, generated in application code.

Never expose or depend on SQLite `rowid`.

## Time

Persist UTC ISO-8601 timestamps with milliseconds.

User-facing scheduling converts via explicit IANA timezone (Temporal polyfill or a well-maintained library).

Never rely on host local timezone for campaign semantics.

## URLs

Normalize for matching but preserve original URL.

Never navigate to `javascript:`, `data:`, `file:` or other unsupported schemes from task input.

## Errors

Stable machine codes:

```text
VALIDATION_FAILED
BROWSER_TARGET_NOT_FOUND
BROWSER_UNSUPPORTED_STATE
BROWSER_SECURITY_CHALLENGE
BROWSER_CHROME_NOT_FOUND
APPROVAL_REQUIRED
APPROVAL_STALE
POLICY_SUPPRESSED
POLICY_CAP_REACHED
EMAIL_AUTH_REQUIRED
SIDE_EFFECT_OUTCOME_UNKNOWN
WORKFLOW_RETRY_EXHAUSTED
AI_BUDGET_EXCEEDED
AI_OUTPUT_INVALID
```

User-facing text is separate (i18n-ready, English first).

## Git

Suggested branches:

```text
main
feature/<short-name>
fix/<short-name>
```

Commits should be small enough to review.

Do not mix lockfile churn with unrelated changes.

## Documentation

A changed contract (protocol message, schema, adapter-pack format) must update docs in the same change.

Important architecture decisions go to ADR.

## Fixtures

Controlled test webpages live under `fixtures/sites`.

Do not copy proprietary third-party HTML wholesale into the repository. Build representative minimal fixtures.

## Feature flags

Use settings flags for risky/incomplete adapters such as LinkedIn.

Flags fail closed.

## Code generation by Claude Code

Claude Code must:

- inspect existing implementation first;
- not overwrite working modules wholesale without need;
- run typecheck/lint/tests;
- avoid creating duplicate abstractions;
- remove obsolete code when replacing it;
- not leave parallel old/new implementations unless migration requires it.
