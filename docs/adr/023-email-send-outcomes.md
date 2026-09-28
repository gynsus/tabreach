# ADR 023 — Email send outcomes: Message-ID from the intent, staged SMTP, Sent reconciliation

**Status:** Accepted (2026-09-28, Phase 3a). Refines ADR 016 and ADR 018.

## Context

ADR 016 requires an app-generated `Message-ID` "persisted before sending" and reconciliation by searching Sent. ADR 018/021 require that an uncertain send is never re-sent automatically. Implementing SMTP showed three gaps:

1. Persisting a random `Message-ID` before sending is a second write that must happen before the ledger's `executing` state — another place to get the order wrong.
2. nodemailer reports every unexpected connection close as command `CONN`, whatever the connection was doing. Its error cannot tell "never connected" from "the server received the message but the answer was lost" (verified with a local server that drops the connection after `DATA`).
3. "Not found in Sent" means different things: on servers that keep sent mail (Gmail, Outlook) it is evidence of absence once search indexing caught up; on servers where TabReach appends the copy itself, the copy may simply be missing after a crash; without a Sent folder it means nothing.

## Decision

- **Message-ID is derived from the ledger key:** `<first 40 hex of the idempotency key>@<sender domain>`. The same intent always carries the same id, so nothing extra is stored before the send and reconciliation needs only the key. The id names nothing about TabReach. It is also recorded in the ledger's `external_refs` after the send.
- **SMTP is driven in explicit stages** (`connect` → `auth` → `submit`) on one connection. Only a failure while connecting or logging in, or an explicit refusal by the server (4xx/5xx reply), is `not_sent`. Anything else during `submit` — lost connection, timeout, unexpected error — is `unknown`. A refused recipient (5xx on `RCPT TO`) is `not_sent` and **permanent**: the enrollment stops (`send_failed`) instead of retrying.
- **Reconciliation** searches the account's Sent folder (IMAP special-use `\Sent`) for the Message-ID:
  - found → `completed` (`provider_lookup`);
  - no Sent folder, or an account where TabReach appends to Sent itself → `unknown`: only a person can decide;
  - server keeps sent mail, not found, less than 10 minutes since the attempt → `pending`: the job continues later without spending an attempt;
  - server keeps sent mail, not found after 10 minutes → `not_sent`, and the message may be sent.
  - Sent cannot be searched (connection error) → `pending`.
- A person settles `unknown` from "Needs attention" (`sideEffects.resolve` → `user_confirmation`); only a "not sent" answer lets TabReach send.
- Whether a server keeps sent mail is decided from the SMTP host at connection time (Gmail, Outlook/Office 365) and stored on the account.
- An authentication failure while sending puts the account in `auth_required`; its campaigns stop sending until the user enters a new password.

## Audit 3.5 changes (2026-09-28)

- Only the exact submission hosts `smtp.gmail.com`, `smtp.googlemail.com`, `smtp.office365.com` and `smtp-mail.outlook.com` count as keeping a Sent copy; relays such as `smtp-relay.gmail.com` do not.
- **Gmail API:** it is not yet verified on a live account that `users.messages.send` keeps a caller-supplied Message-ID (it does over SMTP — verified on a real account). Until it is, "not found" after the grace period is `unknown` for a person, never `not_sent`.
- Reconciliation that cannot reach the mailbox keeps waiting (`pending`) for at most 24 hours, then becomes `unknown`. A refused IMAP login during reconciliation puts the account on hold.

## Alternatives

- Random Message-ID persisted on the draft or ledger row before sending: equivalent guarantee, one more write in the critical path.
- Trust nodemailer's `command` field: wrong for connection losses (all reported as `CONN`), which is exactly the dangerous case.
- Treat "not in Sent" as `not_sent` for every server: would re-send messages whose Sent copy was lost in a crash — a duplicate.

## Consequences

- On servers without a server-side Sent copy, some interrupted sends need one click from the user. That is the price of never sending twice.
- Tests cover the classification against a real local SMTP server (`smtp-server`), including a connection dropped after the message was received. IMAP is covered through an in-memory fake; there is no IMAP server in CI.
- Pacing is per account: `side_effects.channel_account_id` (migration 9) records which account sent.
