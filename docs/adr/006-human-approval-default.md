# ADR 006 — Human approval is default for critical actions

**Status:** Accepted — amended 2026-09-28 (relationship to execution modes; definition of `approve_campaign`)

## Context

Outbound actions affect external people and accounts. Incorrect recipient/content selection can cause reputational or account harm.

## Decision

Default campaign policy is `approve_each`.

An explicit `approve_campaign` mode may authorize defined critical action classes for a campaign version. Because AI-personalised drafts all differ, `approve_campaign` means: approve the version, review a sample of drafts, then auto-approve only drafts that pass all automated checks; failing drafts fall back to per-item approval (`17-CAMPAIGNS.md`).

Security challenges, target mismatch, stale content and contact policy always override campaign approval.

Approval is independent of execution mode (ADR 015): an `assisted` action still needs approval; the user's final click is an additional gate.

## Consequences

Early throughput is lower, but trust, debuggability and safety are substantially higher. The batch approval queue keeps `approve_each` practical.
