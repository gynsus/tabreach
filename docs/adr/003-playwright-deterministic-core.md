# ADR 003 — Playwright as deterministic browser core

**Status:** Accepted

## Context

AI-only browser agents are flexible but slower, less reproducible and harder to verify.

## Decision

Use Playwright for known browser actions and adapter workflows.

Locator priority favors semantic/stable locators over brittle DOM-position selectors.

## Consequences

Workflows are predictable and testable.

AI semantic tools remain available as fallback rather than owning the primary browser control loop.
