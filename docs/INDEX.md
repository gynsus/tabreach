# Documentation Index

## Start here

1. [`../CLAUDE.md`](../CLAUDE.md) — binding development contract for Claude Code.
2. [`00-PRODUCT-VISION.md`](00-PRODUCT-VISION.md) — what the product is.
3. [`01-MVP-SCOPE.md`](01-MVP-SCOPE.md) — what is and is not in the first release.
4. [`03-SYSTEM-ARCHITECTURE.md`](03-SYSTEM-ARCHITECTURE.md) — executable architecture.
5. [`22-IMPLEMENTATION-PLAN.md`](22-IMPLEMENTATION-PLAN.md) — phase order.
6. [`26-FIRST-CLAUDE-CODE-TASK.md`](26-FIRST-CLAUDE-CODE-TASK.md) — first task to give Claude Code.
7. [`REVISION-NOTES-2026-09-28.md`](REVISION-NOTES-2026-09-28.md) — what changed in the architecture revision and why (Russian).

## Product and requirements

- [`00-PRODUCT-VISION.md`](00-PRODUCT-VISION.md)
- [`01-MVP-SCOPE.md`](01-MVP-SCOPE.md)
- [`02-FUNCTIONAL-REQUIREMENTS.md`](02-FUNCTIONAL-REQUIREMENTS.md)
- [`23-ACCEPTANCE-CRITERIA.md`](23-ACCEPTANCE-CRITERIA.md)
- [`24-OUT-OF-SCOPE.md`](24-OUT-OF-SCOPE.md)

## Architecture

- [`03-SYSTEM-ARCHITECTURE.md`](03-SYSTEM-ARCHITECTURE.md)
- [`04-DOMAIN-MODEL.md`](04-DOMAIN-MODEL.md)
- [`05-DATABASE-SCHEMA.md`](05-DATABASE-SCHEMA.md)
- [`06-API-CONTRACT.md`](06-API-CONTRACT.md) — app protocol (renderer ↔ core)

## Browser core

- [`07-BROWSER-RUNTIME.md`](07-BROWSER-RUNTIME.md) — browser worker and browser protocol
- [`08-BROWSER-PROFILES.md`](08-BROWSER-PROFILES.md)
- [`09-BROWSER-INSTRUMENTATION.md`](09-BROWSER-INSTRUMENTATION.md)
- [`10-BROWSER-RECORDER.md`](10-BROWSER-RECORDER.md) — deferred
- [`11-HUMAN-TAKEOVER.md`](11-HUMAN-TAKEOVER.md) — takeover and assisted execution
- [`12-IN-PAGE-OVERLAY.md`](12-IN-PAGE-OVERLAY.md) — replaces the browser extension

## Orchestration and channels

- [`13-WORKFLOW-ENGINE.md`](13-WORKFLOW-ENGINE.md)
- [`14-CHANNEL-ADAPTERS.md`](14-CHANNEL-ADAPTERS.md)
- [`15-AI-ARCHITECTURE.md`](15-AI-ARCHITECTURE.md)
- [`16-RESEARCH-ENGINE.md`](16-RESEARCH-ENGINE.md)
- [`17-CAMPAIGNS.md`](17-CAMPAIGNS.md)

## Quality and operations

- [`18-SECURITY-PRIVACY-COMPLIANCE.md`](18-SECURITY-PRIVACY-COMPLIANCE.md)
- [`19-ERROR-RECOVERY.md`](19-ERROR-RECOVERY.md)
- [`20-OBSERVABILITY.md`](20-OBSERVABILITY.md)
- [`21-TESTING.md`](21-TESTING.md)
- [`25-DEVELOPMENT-CONVENTIONS.md`](25-DEVELOPMENT-CONVENTIONS.md)

## ADRs

The `adr/` directory contains architectural decisions. Superseded ADRs are kept for history; follow the superseding ADR. Claude Code must not silently contradict an accepted ADR.

| ADR | Title | Status |
|---|---|---|
| 001 | Local-only desktop application | Accepted (revised) |
| 002 | Standard browser (user's Chrome), no Chromium fork | Accepted (amended) |
| 003 | Playwright as deterministic browser core | Accepted |
| 004 | Stagehand as semantic fallback | Superseded by 013 |
| 005 | Dedicated managed browser profiles | Accepted |
| 006 | Human approval is default for critical actions | Accepted (amended) |
| 007 | Channel adapter boundary | Accepted (amended) |
| 008 | Prefer APIs/protocols for email; browser for UI-only workflows | Accepted (amended by 016) |
| 009 | No bot-evasion subsystem | Accepted (amended) |
| 010 | Runtime protocol boundary | Superseded by 012 |
| 011 | Single TypeScript stack with SQLite (node:sqlite) and in-DB job queue | Accepted |
| 012 | Electron process topology and in-app IPC | Accepted (worker host: utilityProcess, validated) |
| 013 | Bounded semantic target resolution instead of Stagehand | Accepted |
| 014 | No Chrome extension; runtime-injected overlay | Accepted |
| 015 | Execution modes: auto, assisted, manual | Accepted |
| 016 | Email transports and staged Gmail OAuth client strategy | Accepted |
| 017 | Data-driven adapter packs | Accepted |
| 018 | Side-effect ledger keyed by logical intent | Accepted (refined by 021) |
| 019 | Renderer UI stack and localization | Accepted |
| 020 | Events, core state and command idempotency | Accepted |
| 021 | Workflow engine data model decisions | Accepted |
| 022 | The audit trail stores identifiers, not personal data | Accepted |
| 023 | Email send outcomes: Message-ID from the intent, staged SMTP, Sent reconciliation | Accepted |
| 024 | Reply ingestion: only prospect mail, from the moment of connecting | Accepted |
| 025 | Draft checks and campaign approval | Accepted |

## Recommended first command to Claude Code

> Read `CLAUDE.md`, then the documents in its mandatory reading order and ADRs 020–022. Phases 0, 1 and the 1.5 hardening are done. Implement Phase 2 from `docs/22-IMPLEMENTATION-PLAN.md` following ADR 021 for the data model. (`26-FIRST-CLAUDE-CODE-TASK.md` describes the completed Phase 0 and is kept for history.)
