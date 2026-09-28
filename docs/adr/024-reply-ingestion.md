# ADR 024 — Reply ingestion: only prospect mail, from the moment of connecting

**Status:** Accepted (2026-09-28, Phase 3c). Implements docs/14 "Common email behaviour".

## Context

TabReach reads the user's inbox to notice replies and bounces. A mailbox holds far more than outreach: private mail, invoices, newsletters. Storing it would copy personal data into another database for no product reason, and processing years of history would stop sequences on stale replies.

## Decision

- **Polling**, per active IMAP account, every 2 minutes (a job that continues itself; immediately again while a batch is full). The cursor is IMAP `UIDVALIDITY` + last UID, advanced in the same transaction as each message's result. The first poll — and any `UIDVALIDITY` change — starts from the current end of the mailbox: history is not imported.
- **Only prospect mail is stored.** A message is kept when it
  - answers one of our messages (`In-Reply-To`/`References` → `thread`, strong), or
  - comes from a known contact's address (`contact_address`, strong), or
  - comes from a company's domain or subdomain (`domain_only`: a *possible* reply, stored for review, never acts on its own), or
  - is a delivery report about one of our messages or a known contact's address.
  Everything else is skipped without storing anything. Mailing lists and bulk mail (`List-*`, `Precedence`, `Auto-Submitted`) are skipped; role senders (`noreply@`, `billing@`, …) count only inside a campaign thread; out-of-office replies are stored for context but stop nothing.
- **Consequences of a reply** (strong match, not automatic): all active or paused sequences of the contact stop (`replied`); if the contact policy's company stop is on, the company's other contacts stop too (`company_replied`). A possible reply does this only when the user confirms it.
- **Bounces**: a permanent failure (status 5.x.x or `Action: failed`) for the contact's address marks it `bounced`, adds an email suppression (`bounce`) and stops the contact's sequences (`bounced`). Delays (4.x.x) are recorded only.
- Only what the sender wrote is stored: the quoted earlier message (Apple Mail, Gmail EN/RU, Outlook introductions, or a trailing `>` block), a standard `-- ` signature and invisible leftovers such as image placeholders are removed (`reply-text.ts`). If nothing would remain, the whole text is kept.
- Outgoing campaign mail is recorded as an outbound message when the send completes, so replies thread to it.
- Rule-based classification only (reply / out-of-office / automatic / bounce); AI classification (interested, opt-out, …) comes with the AI gateway (Phase 4).

## Consequences

- The database holds prospect conversations only; erasing a person removes their conversations with them.
- A reply to an address that is not a contact, from a domain no company has, is invisible to TabReach by design.
- Replies are noticed within about two minutes while the app runs; after sleep or a restart the backlog is read on the next poll.
