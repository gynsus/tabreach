# ADR 017 — Data-driven adapter packs

**Status:** Accepted (2026-09-28)

## Context

LinkedIn (and to a lesser extent generic forms) change their UI often. In a distributed desktop app, locators hard-coded in adapter code mean every user is broken until a new app release is built, signed, notarized and installed. Locale also matters: LinkedIn's UI language changes accessible names.

## Decision

Browser adapters are state machines in code that consume **adapter packs** — versioned, schema-validated data:

- page states (positive conditions: URL patterns, required/forbidden roles/names/text);
- locators with locale variants;
- verification rules (post-action states);
- challenge/login state definitions;
- default limits.

Packs contain no executable code. Every action event records the pack ID and version.

MVP: packs are bundled with the app.

Post-MVP: packs may be delivered independently as Ed25519-signed files verified against a public key embedded in the app, falling back to the bundled version on verification failure.

## Consequences

- UI changes can be fixed by editing data and fixtures, and later shipped without an app release.
- The `unsupported_state` rate per pack version is a direct signal of site changes.
- Pack schema design is an upfront cost; keep it minimal and extend when adapters need it.
