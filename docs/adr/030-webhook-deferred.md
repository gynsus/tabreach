# ADR 030 — The webhook step is deferred to after the MVP

**Status:** Accepted (2026-10-10, Phase 8)

## Context

docs/01 listed `webhook` among the MVP sequence step types, docs/17 an optional per-campaign webhook, and docs/14 a webhook adapter (HMAC-signed event to a configured URL, bounded retries, idempotency key header) for handing data to an external CRM or automation tool. The Phase 4.5 audit found it unassigned. docs/00 lists "CRM integrations via webhooks/exports" as a long-term direction, not an MVP commitment.

A webhook is a user-configured destination, so it is outbound traffic CLAUDE.md §1 allows (a site the user works with). It is still a new path by which prospect data leaves the app automatically, and it needs its own design: which fields are sent, where the signing secret lives, what happens while the receiver is down, how a delivery shows on the timeline.

## Decision

- The `webhook` step type and the per-campaign webhook are not part of the MVP. Nothing is built for them now.
- The campaign status CSV export (FR-PROS-007, Phase 8d) is how data reaches a CRM meanwhile, by hand.
- docs/14 keeps the intended adapter shape for when it is built after the MVP; that work starts with its own ADR on the payload, secret storage and delivery semantics.

## Alternatives

- **Build it in Phase 8d:** covers automatic CRM sync, but adds a data-egress path, a secret and a retrying delivery queue to test and harden before the first release, for a need the CSV export meets.
- **Drop it entirely:** loses a cheap, generic integration point that docs/00 names as a direction.

## Consequences

- docs/01, 14, 17, 22 and 24 say the webhook is post-MVP.
- No schema, protocol or code changes: nothing referenced a webhook.

## Migration impact

None.
