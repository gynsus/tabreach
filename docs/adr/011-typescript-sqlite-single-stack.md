# ADR 011 — Single TypeScript stack with SQLite and an in-database job queue

**Status:** Accepted (2026-09-28)

## Context

The original stack was PHP/Symfony (API), Node/TypeScript (browser runtime), Electron/React (desktop), PostgreSQL, Redis and RabbitMQ under Docker Compose. It was chosen for a local-first app that might later move its API to the cloud.

The product is now local-only and must install as a normal Mac app for external users (ADR 001). Consequences of keeping the original stack:

- end users would need Docker Desktop, or we would have to bundle a PHP runtime (e.g. FrankenPHP static build), a PostgreSQL server, a broker, and supervise them — each a separate signing/notarization and failure surface;
- two languages across the browser boundary require generated/mirrored DTOs and contract tests for every message;
- RabbitMQ + PostgreSQL create a dual-write problem (state change and message publish are not atomic) that needs an outbox — not mentioned in the original docs;
- Redis held only ephemeral locks/counters that one process can keep itself.

## Decision

- **Language:** TypeScript everywhere (Electron main/renderer, core, browser worker).
- **Database:** SQLite, single file, WAL mode, opened only by core. ORM/migrations: Drizzle + drizzle-kit (alternative if it proves limiting: Kysely + own migrator).
- **Driver:** `better-sqlite3` by default. The Phase 0 spike checks the Electron-vs-Node native module ABI handling for tests; if `node:sqlite` (built into Node) is stable enough in the Electron version used, it may replace it to avoid native modules. Record the outcome here.
- **Queue and scheduling:** a `jobs` table in the same database. Enqueue happens in the same transaction as the state change (no dual write, no outbox). One dispatcher in core; leases detect crash-orphaned jobs; backoff and dead jobs as in `13-WORKFLOW-ENGINE.md`.
- **Locks/counters:** in-process in core, persisted where they must survive restarts.
- **Live updates:** core events over MessagePort to the renderer.

## Alternatives

- PHP kept, packaged with FrankenPHP static binary + SQLite: feasible, but exotic packaging, two languages remain, PHP long-running workers need supervision. Rejected as higher total risk.
- Embedded PostgreSQL (bundled binaries): more features than needed, larger bundle, another process. Rejected for MVP; SQLite fits single-user workloads.
- node:sqlite from the start: attractive (no native module) but API stability depends on the Node version inside Electron — evaluated in Phase 0.

## Consequences

- One language, shared types through `packages/protocol`, one build/packaging pipeline (electron-builder).
- Transactional job enqueue makes idempotency and recovery simpler.
- SQLite has a single writer; core is designed as that writer. Throughput is far beyond one user's needs.
- A later Windows build is cheap.
- The owner's PHP expertise is not used; code is TypeScript.

## Phase 0 spike results

_To be filled in by Phase 0 (driver choice, packaging notes)._
