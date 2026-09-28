# 10 — Browser Recorder

## MVP status

**Deferred — not part of the MVP** (revision 2026-09-28).

The recorder was planned as an MVP-supporting developer tool (Phase 11 of the original plan). It was moved out of the MVP because:

- adapter packs for the MVP channels (web forms, LinkedIn) are authored by the developer against fixtures and real pages; a recorder speeds this up only marginally;
- the recorder depended on the Chrome extension, which is also removed (ADR 014);
- it added a phase late in the plan without contributing to any acceptance criterion.

## What remains in the MVP

A lightweight developer aid is acceptable when needed, without a dedicated phase:

- Playwright's own tooling (`codegen`, trace viewer) used by the developer when authoring adapter packs;
- the worker's diagnostics (accessibility snapshot + screenshot on `unsupported_state`) serve as input for updating adapter packs.

## Future design constraints (post-MVP)

If a recorder / teach mode is built later:

- output is a structured recording (semantic targets: role, accessible name, label; resulting page state), never raw position-based selectors;
- sensitive values (passwords, tokens, private message content) are never stored as reusable template data;
- a recording is a hint, not trusted automation — conversion to an adapter pack requires normalized targets, declared page states, marked critical actions, verification, fixture tests and explicit developer approval;
- output format should be the adapter-pack format (ADR 017), so recordings and hand-written packs share one execution path.
