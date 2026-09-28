# ADR 008 — Prefer official APIs/protocols for email; browser for UI-only workflows

**Status:** Accepted — amended 2026-09-28 (email transports defined in ADR 016)

## Context

The browser can technically automate webmail, but email providers offer APIs and standard protocols with better reliability, thread identifiers, reply ingestion and authorization.

## Decision

Email uses the Gmail API (with a user-owned OAuth client) or IMAP/SMTP, never browser automation. Details in ADR 016.

Use the browser worker where the required workflow is genuinely UI-based or lacks a suitable API (web forms, LinkedIn).

## Consequences

The product is browser-first, not browser-only.

This reduces fragility and unnecessary UI automation.
