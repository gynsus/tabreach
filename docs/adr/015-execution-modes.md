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

## Implementation (`manual`, 2026-10-09)

- Channels: email and test steps are `auto` only; a website form step is `auto` or `assisted` (`mode.manualUnsupported` for `manual`); a LinkedIn step may be `auto` (with the per-class opt-in), `assisted` or `manual`.
- A `manual` LinkedIn step is approved like any other, then runs the same `commit` task up to the checkpoint without typing or pressing: the worker opens the profile, checks the person (FR-LIN-003), for a message follows the navigation steps to the conversation page, for an invitation stays on the profile (`manualSkipsSteps`: the invitation page reached by its link has nothing under the dialog once it is closed; the person presses Connect, which opens the dialog over the profile), and stops at `about_to_commit`, where core runs the final checks (policy, limits, kill switch) and marks the ledger entry `executing`. The prepared text is shown in the in-page overlay with a Copy button (docs/09); nothing is typed into the page.
- The task ends `unknown` (`task.manual`); the window is handed to the person (`human` control mode); the send is listed under Status → Needs attention → Unconfirmed sends, and "It was sent" / "It was not sent" is the reconciliation (`user_confirmation`). Nothing is pressed again until the person answers.
- The conversation is read before a manual message as before (FR-LIN-004): an answer stops it before anything is opened for the person.
- The overlay shows the text only on pages of the target's origin (`contentOrigin`); anywhere else in the window it is left out, and its titles name no one (docs/12, audit 5.5).
- The `unknown` of a manual step waits for the person at once (a browser channel is never retried for reconciliation). After their answer the window comes back under automation with the next send of that profile; "It was not sent" runs the step again and hands the page over again.
