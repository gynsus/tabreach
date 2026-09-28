# ADR 018 — Side-effect ledger keyed by logical intent

**Status:** Accepted (2026-09-28); refined by ADR 021 §3 — ledger statuses are `reserved | executing | completed | not_sent | unknown` (no `failed`), re-execution only from `not_sent`, key = sha256 of the logical-intent parts.

## Context

The original design derived the idempotency key from workflow ID, step, target and **content hash/action fingerprint**, with a generic `idempotency_keys` table.

Failure scenario: a send ends `unknown` (crash after click, before verification). The user edits the draft and re-approves. The content hash changes → a new key → the system sends again. The recipient gets two messages.

Also, for browser actions a crash after the irreversible click must be distinguishable from a crash before it.

## Decision

- A `side_effects` table is the ledger of external actions: one row per **logical intent**, keyed by enrollment (or standalone workflow), step position, channel/action type and target identity. Content hash is recorded but is **not** part of the key.
- Status flow: `reserved → executing → completed | failed | unknown`.
- `executing` is written **before** the irreversible operation; for browser tasks this is the `about_to_commit` checkpoint acknowledged by core.
- A row in `executing` or `unknown` can only be resolved by reconciliation (provider lookup, UI verification, user confirmation), never by re-execution.
- Retry of the same key is allowed only from `failed` with a retryable error class and verified not-sent.

## Consequences

- Editing content never creates a second send for the same intent.
- Crash windows are explicit and testable.
- A deliberate re-send (e.g. user wants to send a corrected message) is a new, explicit user action with its own intent, not a retry.
