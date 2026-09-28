# ADR 004 — Stagehand as semantic fallback

**Status:** Superseded by ADR 013 (2026-09-28)

## Original context

Web UIs change and deterministic selectors sometimes fail. Building a full semantic browser-agent layer from scratch was considered unnecessary for MVP.

## Original decision

Use Stagehand for bounded semantic observation/action only after deterministic Playwright resolution fails or where semantic extraction is inherently useful.

## Why superseded

See ADR 013: Stagehand calls AI providers from the browser process (second AI call site and key store), drives the page through its own layer alongside Playwright, and offers more freedom (`act`) than the product's safety model wants. A narrow in-house resolver over Playwright accessibility data covers the actual need.
