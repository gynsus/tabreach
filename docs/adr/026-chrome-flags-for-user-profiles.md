# ADR 026 — Chrome runs as a normal browser in user profiles

**Status:** Accepted (2026-09-29, Phase 5a follow-up). Found in the owner's live check: Chrome showed "You are using an unsupported command-line flag: --no-sandbox".

## Context

Playwright launches Chromium with defaults made for tests: the sandbox off unless `chromiumSandbox` is set, background networking, component updates, phishing detection and popup blocking off, and a mock Keychain so cookies are encrypted with a fixed key. In a TabReach profile the user signs in to real accounts (LinkedIn, Google); the profile directory is credential-equivalent (docs/08). Test defaults there would weaken exactly what protects those accounts.

## Decision

Profiles (`ProfileManager`) launch Google Chrome with:

- `chromiumSandbox: true` — Chrome's sandbox stays on;
- these Playwright defaults removed (`ignoreDefaultArgs`): `--disable-background-networking` (Safe Browsing lists), `--disable-component-update` (security components), `--disable-client-side-phishing-detection`, `--disable-popup-blocking`, `--disable-prompt-on-repost`, `--disable-hang-monitor`, `--disable-default-apps`;
- the real macOS Keychain for cookie and saved-data encryption (`--use-mock-keychain` and `--password-store=basic` removed). Tests keep the mock Keychain (`keychain: false`): a CI runner cannot answer a Keychain prompt.

Kept: `--enable-automation` and its infobar (ADR 009: automation is never hidden), `--disable-extensions` (no extension is needed; ADR 014), and Playwright's `--disable-features` list for now — it also disables `HttpsUpgrades` and `ThirdPartyStoragePartitioning`; removing it needs the exact generated string and is left for Phase 8 hardening.

The throwaway launch check (`launchCheck`) keeps Playwright's defaults: it signs in to nothing and is deleted at once.

A browser test opens `chrome://version` in a profile and asserts none of the removed flags is on the command line.

## Consequences

- Profiles opened before this change had cookies encrypted with the mock key; Chrome cannot read them with the Keychain key, so the user signs in to those sites once more.
- Chrome may use the "Chrome Safe Storage" Keychain item like the user's own Chrome does.
