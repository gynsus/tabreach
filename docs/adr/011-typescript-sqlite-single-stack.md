# ADR 011 — Single TypeScript stack with SQLite and an in-database job queue

**Status:** Accepted (2026-09-28; driver and data-access decision finalized by the Phase 0 spike, 2026-09-28)

## Context

The original stack was PHP/Symfony (API), Node/TypeScript (browser runtime), Electron/React (desktop), PostgreSQL, Redis and RabbitMQ under Docker Compose. It was chosen for a local-first app that might later move its API to the cloud.

The product is now local-only and must install as a normal Mac app for external users (ADR 001). Consequences of keeping the original stack:

- end users would need Docker Desktop, or we would have to bundle a PHP runtime (e.g. FrankenPHP static build), a PostgreSQL server, a broker, and supervise them — each a separate signing/notarization and failure surface;
- two languages across the browser boundary require generated/mirrored DTOs and contract tests for every message;
- RabbitMQ + PostgreSQL create a dual-write problem (state change and message publish are not atomic) that needs an outbox — not mentioned in the original docs;
- Redis held only ephemeral locks/counters that one process can keep itself.

## Decision

- **Language:** TypeScript everywhere (Electron main/renderer, core, browser worker).
- **Database:** SQLite, single file, WAL mode, opened only by core.
- **Driver:** Node's built-in `node:sqlite` (`DatabaseSync`), decided by the Phase 0 spike (see below).
- **Data access:** no ORM. Migrations are plain SQL kept in TypeScript (`packages/core/src/db/migrations.ts`), numbered 1..n, checksummed and applied by core's own small runner. Repositories use prepared statements and validate JSON columns with Zod.
- **Queue and scheduling:** a `jobs` table in the same database. Enqueue happens in the same transaction as the state change (no dual write, no outbox). One dispatcher in core; leases detect crash-orphaned jobs; backoff and dead jobs as in `13-WORKFLOW-ENGINE.md`.
- **Locks/counters:** in-process in core, persisted where they must survive restarts.
- **Live updates:** core events over MessagePort to the renderer.

## Alternatives

- PHP kept, packaged with FrankenPHP static binary + SQLite: feasible, but exotic packaging, two languages remain, PHP long-running workers need supervision. Rejected as higher total risk.
- Embedded PostgreSQL (bundled binaries): more features than needed, larger bundle, another process. Rejected for MVP; SQLite fits single-user workloads.
- `better-sqlite3` + Drizzle: mature, but a native module is compiled for one ABI at a time. Electron and the plain Node used by tests need different builds, so switching between tests and the app means a rebuild, plus an install-script allowlist entry. Rejected after the spike.
- Drizzle over `node:sqlite`: only available in Drizzle 1.0 beta/RC at decision time (stable 0.45 lacks the driver), and the project pins stable versions. Revisit when Drizzle 1.0 is stable if hand-written SQL becomes a burden.
- Kysely: needs a community dialect for `node:sqlite`; same revisit condition.

## Consequences

- One language, shared types through `packages/protocol`, one build/packaging pipeline (electron-builder).
- Transactional job enqueue makes idempotency and recovery simpler.
- SQLite has a single writer; core is designed as that writer. Throughput is far beyond one user's needs.
- A later Windows build is cheap.
- The owner's PHP expertise is not used; code is TypeScript.

## Phase 0 spike results

Spike run 2026-09-28 on Apple Silicon, macOS 26.3, Electron 44.4.5 (Node 24.21.0, SQLite 3.53.4), packaged with electron-builder 26.15.3.

- `node:sqlite` works in an Electron `utilityProcess` inside the packaged app and in plain Node 24 for tests, with no warnings. Verified: WAL, `STRICT` tables, `CHECK (json_valid(...))`, transactions and rollback, online `backup()` (used for the pre-migration local recovery backup) and `VACUUM INTO`.
- `better-sqlite3` 13.0.3 also works once rebuilt for Electron, but the same build does not load in plain Node (the dual-ABI problem above).
- Decision: `node:sqlite`, no native modules in the app.
- Packaging note: flipping Electron fuses invalidates the ad-hoc signature, and an unsigned arm64 binary is killed on launch (exit 137). The build therefore ad-hoc signs after applying fuses (`mac.identity: '-'`, hardened runtime on) until Developer ID signing arrives in Phase 8.
