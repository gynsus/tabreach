# ADR 001 — Local-only desktop application

**Status:** Accepted — revised 2026-09-28 (originally "Local-first MVP" with Docker Compose infrastructure and a planned cloud control plane)

## Context

The product depends on authenticated browser sessions and visible human takeover. The owner's decisions (2026-09-28):

- the product is installed on the user's own computer and works locally — permanently;
- there is no SaaS/cloud control plane in the roadmap;
- it is built first for the owner and later distributed to external users as an installable app.

The original version ran a local Symfony API with PostgreSQL, Redis and RabbitMQ via Docker Compose and kept "SaaS-ready" boundaries so the API could later move to the cloud.

## Decision

The product is a single self-contained macOS desktop application:

- Electron app with in-process-tree services (see ADR 011, ADR 012);
- SQLite database file in Application Support;
- the user's installed Google Chrome with app-managed profiles;
- no Docker, no local servers, no listening ports;
- external calls only to AI/email providers the user configured and to the sites being worked with.

"SaaS-ready" boundaries, workspace/tenant IDs and cloud-migration requirements are removed.

## Alternatives

- Keep Docker Compose infrastructure: unacceptable for external users (Docker Desktop is heavy, licensed for larger companies, cannot be bundled into a notarized app).
- Hybrid local runtime + cloud control plane: rejected by product decision; adds accounts, servers, data custody.

## Consequences

Positive:

- browser/session data and prospect data stay on the machine;
- installation is a normal `.app`;
- far fewer moving parts.

Negative:

- the Mac must be awake and the app running for campaigns (mitigated by keep-awake option and catch-up scheduling);
- no multi-device use;
- scaling is bounded by one machine (acceptable for the target user).
