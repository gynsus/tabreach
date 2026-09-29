# ADR 013 — Bounded semantic target resolution instead of Stagehand

**Status:** Accepted (2026-09-28, rationale corrected in review round 2). Supersedes ADR 004.

## Context

When a deterministic locator fails (page changed), the product needs AI help to find the right element. ADR 004 chose Stagehand.

Stagehand v4 changed substantially: it no longer depends on Playwright; target management, state and CDP dispatch moved into its own layer, including a built-in browser extension/service worker. With a bring-your-own model, completions can be requested back in the user's process over RPC — so a second key store is **not** an inherent property of v4 (an earlier version of this ADR claimed it was; that claim is withdrawn).

The actual reasons against it:

- it introduces another browser-control and state layer (plus an in-browser extension component) next to Playwright. Browserbase itself notes that Playwright and Stagehand can hold separate CDP sessions but still interfere at the browser-state level (both can navigate, close tabs, change cookies);
- the product's need is deliberately narrow — "choose one element from a closed candidate set" — while Stagehand's `act`/agent capabilities are broader than the safety model allows;
- a small resolver is easier to audit, test with a fake model, and keep provider-independent behind the single AI gateway.

## Decision

Implement a small resolver:

1. the worker enumerates candidates in a scoped region using Playwright accessibility data (`ariaSnapshot`, role queries), assigning refs with role, accessible name, nearby text and position;
2. it asks core's AI gateway (`ai.resolveTarget`) to choose one ref or none, with rationale and confidence;
3. the worker performs a deterministic Playwright action on that element and verifies the outcome.

Rules: closed candidate set; no free-form selectors, URLs or typing from the model; bounded attempts; not used for the final target of a critical action in `auto` mode; all resolutions recorded (candidates, choice, model, rationale).

## Alternatives

- Stagehand v4: capable, but adds a second control/state layer and more autonomy than needed.
- Vision-only (screenshot + coordinates): less deterministic, harder to verify; may be added as optional context later.

## Implementation (Phase 6c, 2026-09-29)

For website forms the closed list is a list of meanings per field (for fields the pack's phrases missed) or of the site's own links (to find the contact page), asked once per preparation through the gateway (`form.fields`, `form.contactLink`; docs/15). The answer is checked against what was sent; a consent is never a choice; the submit button is never resolved this way, and sending never asks. Resolutions are audited with counts, not page text.

## Consequences

- One browser-control layer (Playwright), one AI gateway, one budget.
- Resolution is auditable and testable.
- Less "magic" than a general agent — intentionally; unknown states go to a human.
- Revisit if, after real use, the resolver proves too weak for the adapters' recovery needs.
