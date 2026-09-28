# ADR 002 — Standard browser, no Chromium fork

**Status:** Accepted — amended 2026-09-28 (browser = the user's installed Google Chrome)

## Context

Browser automation is central, which raises the possibility of building a custom Chromium distribution.

Maintaining Chromium introduces major ongoing cost: builds, merges, security updates, signing, codecs, platform support and browser regressions.

## Decision

The MVP uses the user's installed, auto-updating Google Chrome (`channel: 'chrome'`) with dedicated app-managed profiles, driven by Playwright behind the browser-worker abstraction.

No Chromium fork. No bundled or downloaded browser in the MVP. Playwright's Chromium is used for automated tests only.

## Consequences

We gain most required functionality through Playwright/CDP while real logins happen in a genuine, up-to-date Chrome.

The app depends on Chrome being installed; the setup wizard and health checks detect it.

Chrome updates are outside our control; versions are recorded in diagnostics and action events.

Revisit only if multiple proven product requirements cannot be met through the standard browser.
