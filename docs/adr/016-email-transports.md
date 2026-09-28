# ADR 016 — Email transports and staged Gmail OAuth client strategy

**Status:** Accepted (2026-09-28; staged OAuth strategy added in review round 2). Amends ADR 008.

## Context

The product has no server and will be distributed to external users.

Facts:

- Desktop apps obtain Google OAuth tokens without any server: system browser → consent → loopback redirect to `127.0.0.1` → code exchange with PKCE → refresh token stored locally. Google recommends the loopback flow for desktop apps. Google verifies the OAuth **client registration**, not where the code runs.
- `gmail.send` is a **sensitive** scope; `gmail.readonly` (needed for reply ingestion and Sent reconciliation) is **restricted**.
- A single publisher-owned client used by many users needs Google verification; restricted scopes add a stricter review, typically including an annual third-party security assessment.
- In "Testing" publishing status, External clients' refresh tokens typically expire after 7 days; in "In production" that limit does not apply.
- Google's personal-use exception: an app used only by its owner (or a few people they know personally) need not be verified; users pass through the unverified-app warning. Workspace **Internal** apps need no verification.
- Self-hosted tools such as n8n use exactly this approach: each user creates their own OAuth client.

## Decision

Two transports behind one `EmailTransport` interface:

1. **Gmail API.**
2. **IMAP/SMTP** — any provider; OAuth2/XOAUTH2 where required, otherwise app passwords.

Gmail OAuth client strategy, staged:

- **MVP — option A (user-owned client):** the setup wizard guides the user to create a Google Cloud project, enable Gmail API, configure the consent screen (External), set publishing status to In production, and create a Desktop app client. Wording in the product: *a user-owned OAuth project used only by that user may qualify for Google's personal-use verification exception; it remains subject to the unverified-app warning, user caps, Workspace administrator policies and Google's OAuth policies.*
- **MVP — option B (Workspace Internal client):** wizard branch for Google Workspace accounts; no verification, no warning.
- **Later — option C (publisher-owned verified client):** when distributing to external users, register a TabReach client and complete Google verification. Before starting, confirm with Google's current policy: (a) whether the restricted-scope security assessment applies to an app that keeps Google user data only on the user's device; (b) Limited Use disclosure for sending email content to the user's own AI provider. The transport code is identical; only the client ID source changes (built-in vs user-provided).

Rejected: an OAuth broker server to hide the client secret — desktop client secrets are not confidential by design, and a server breaks the local-only model (ADR 001).

Every outbound message carries an app-generated `Message-ID`, persisted before sending, used to reconcile interrupted sends by searching the Sent mailbox (with delayed retries for search indexing). The guarantee is **no automatic duplicate**, not exactly-once: with generic SMTP a lost response after `DATA`, or a crash between submission and `IMAP APPEND`, leaves the outcome `unknown` (ADR 018).

Bounce detection, reply matching (with match strength) and classification are transport-independent.

## Implementation (Phase 3b, 2026-09-28)

- Core builds the consent URL (PKCE S256, `state`, `access_type=offline`, `prompt=consent`, scopes `gmail.send` + `gmail.readonly`) and asks main over the host channel (`oauth.loopback`). Main opens it with `shell.openExternal`, listens once on `127.0.0.1:<random port>` (Google hosts only, 10-minute limit) and returns the redirect parameters. Core checks `state`, exchanges the code with the verifier, requires both scopes and a refresh token, reads the address from the Gmail profile.
- Stored: the refresh token (`oauth_refresh_token`) and, if given, the client secret (`oauth_client_secret`), both encrypted via main; the client ID in account metadata. Access tokens live only in memory. `invalid_grant` puts the account in `auth_required`; signing in again renews the same account.
- Sending uses `users.messages.send` with the same Message-ID rule as SMTP (ADR 023); reconciliation searches `rfc822msgid:`. Replies come from `users.history.list` (INBOX, messageAdded) starting at the profile's history id at connection time; an expired history id restarts from the current one (ADR 024).
- Microsoft and XOAUTH2 for IMAP/SMTP are not implemented yet.

## Alternatives

- Only option C from day one: best UX, but verification cost and time before the product is even validated.
- IMAP/SMTP only: simplest, but Gmail app passwords require 2-Step Verification, may be disabled by Workspace admins, and are a weaker credential; the API gives better thread IDs and history.
- Verified client with `gmail.send` only + IMAP app password for reading: avoids restricted scopes but gives users two credentials for one mailbox. Not planned.
- Browser automation of webmail: rejected (ADR 008).

## Consequences

- MVP needs no verification cost or server; tokens belong to the user's own client.
- Setup takes ~10–15 minutes for option A; the wizard and docs must be excellent.
- Workspace admins may block unverified third-party apps; IMAP/SMTP or admin approval are the fallbacks.
- Option C can be added later without architectural change; its cost/time must be researched before distribution to external users.
- Microsoft mailboxes are covered by IMAP/SMTP with OAuth2 until a Graph adapter exists.
