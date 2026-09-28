# ADR 022 — The audit trail stores identifiers, not personal data

**Status:** Accepted (2026-09-28, owner decision in the Phase 1 audit)

## Context

`action_events` is append-only, enforced by database triggers, so that the history of what TabReach did cannot be rewritten. Phase 1 wrote personal data into event payloads: suppressed email addresses, company names and domains. Combined with append-only storage, that data could never be erased — a person asking to be forgotten could be removed from `contacts` but would remain in the audit trail forever. Phase 2 would add message targets and content to the same table.

## Decision

- Audit payloads carry only **identifiers, field names, counts, enums and codes**: object ids, changed field names (`["email", "tags"]`), import counts, suppression kind and reason.
- Never: names, emails, domains, URLs, profile links, message text, free-text notes.
- The object id points at the record that holds the data; erasing that record erases the data. The history then reads "Contact updated · changed: email" for a contact that no longer exists.
- Payloads additionally pass through the shared secret redaction (`redactDeep`).
- A regression test asserts that creating a company and suppressing an email leaves none of those values in the audit trail.

## Alternatives

- Keep PII and allow deleting audit rows: breaks the append-only guarantee that makes the trail trustworthy.
- Encrypt PII in payloads and delete the key on erasure (crypto-shredding): workable, but key management per person is heavy for a local single-user app.

## Consequences

- Erasure of a person is possible without touching the audit trail.
- The activity view shows less detail for events whose object was deleted; for existing objects the UI links to the current record.
- Events written before this change (development databases only) still contain PII; there are no released installations.
