# ADR 015 — Execution modes: auto, assisted, manual

**Status:** Accepted (2026-09-28)

## Context

The original design offered approval followed by automatic execution, or full human takeover as an exception. For LinkedIn — important to the product — fully automatic UI actions carry real account risk (LinkedIn prohibits automation; the product does not hide automation), and for web forms and LinkedIn verifying the outcome is sometimes impossible.

## Decision

Every critical step has an execution mode:

- `auto` — the worker performs the final action after approval;
- `assisted` — the worker prepares everything and highlights the final control; the user clicks; the worker verifies;
- `manual` — the system prepares content and opens the target; the user acts and confirms the outcome.

Adapters declare allowed and default modes. Defaults: email `auto`, web forms `auto`, LinkedIn `assisted` (`auto` only via explicit opt-in per action class).

Execution mode is orthogonal to approval mode (ADR 006).

When outcome cannot be verified from the UI, the user's confirmation is a first-class reconciliation source for the side-effect ledger.

## Consequences

- LinkedIn usage is closer to a human-operated assistant; account risk and product positioning improve.
- Throughput in `assisted` mode is bounded by the user's attention; the UI must make the queue of "waiting for your click" items efficient.
- Workflows need `AWAIT_USER_CLICK` states and timeouts.
