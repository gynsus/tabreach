# ADR 009 — No bot-evasion subsystem

**Status:** Accepted — amended 2026-09-28 (see Amendment)

## Context

A browser automation product could drift into stealth/fingerprint spoofing, automated CAPTCHA solving or security-control bypass.

## Decision

MVP will not implement:

- anti-detect browser features;
- fingerprint spoofing;
- CAPTCHA solving;
- stealth plugins intended to evade platform detection;
- proxy rotation for bypass purposes.

Challenges transition to human intervention.

## Consequences

The system is easier to reason about and safer to operate. Some sites/channels may remain unsuitable for automated execution and can be disabled or used manually.

## Amendment (2026-09-28)

Automation indicators that Chrome and Playwright expose (the "controlled by automated test software" notice, `navigator.webdriver`) are accepted and must not be patched. The runtime-injected overlay is likewise visible to page scripts. Minimum spacing and limits in adapter packs are review/quality controls; they must not be randomized or tuned to imitate humans for evasion purposes. For LinkedIn, `assisted` execution (ADR 015) is the default instead of any attempt to reduce detectability.
