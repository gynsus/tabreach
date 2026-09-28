# ADR 007 — Channel adapter boundary

**Status:** Accepted — amended 2026-09-28 (placement of browser adapter logic)

## Context

Email, website forms and social/browser channels have different capabilities and failure modes.

Hardcoding channel behaviour into campaign logic would make the product brittle.

## Decision

Campaign engine emits channel-neutral action intents. Adapters validate, prepare, execute, verify and reconcile them.

The intent side of every adapter lives in core. For browser channels, page-level logic (state recognition, locating, filling, clicking, verifying) lives in the browser worker as high-level browser tasks driven by adapter packs (ADR 017). Core never drives a browser click by click.

## Consequences

New channels can be added without rewriting campaign orchestration.

Adapter capability validation (intents and execution modes) occurs before launch.
