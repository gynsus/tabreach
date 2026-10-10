# ADR 031 — Replies written and sent from the inbox

**Status:** Accepted (2026-10-10, Phase 8d)

## Context

docs/01 "Inbox" puts manual response drafting in the MVP: the user reads a prospect's reply and answers it without leaving TabReach. Until now every outbound email belonged to a campaign step, guarded by the campaign engine's workflow run, approval, contact policy and the side-effect ledger (CLAUDE.md §3.5). A reply from the inbox is a critical external action too, but it is not a campaign step: there is no enrollment, no sequence and no approval queue, and the person it goes to has just written.

## Decision

- **A one-step workflow of its own.** A new table `manual_replies` (migration 20) holds what is sent — recipient, subject, body, the threading headers of the answered message, a content hash — and where it stands (`sending | sent | failed | unknown`). The reply's id is the ledger scope: the intent is `(reply id, 1, email, email.reply, recipient)`. The row and its ledger entry are the whole state; a job `reply.send` carries the send across restarts and sleep. No `workflow_runs` row is created.
- **Pressing Send is the approval.** The user writes the text and sends it; there is no separate approval step. The command carries an idempotency key, so a double click is one reply.
- **Which checks apply.** The do-not-contact list applies — to the address written to, its domain and parents, the conversation's contact (their own address and profile URLs) and company — both when Send is pressed and again inside the reserving transaction. Frequency caps, the sending window and the reply hold do not: the person wrote, and the user answers them by hand. Global pause refuses a new reply and holds one already queued. The account's pacing is not applied to the reply, but the reply counts toward it for later campaign sends (it is a send through that account in the ledger).
- **Recipient and thread.** The reply answers the conversation's latest human reply (classification `reply`): it goes to that message's sender, from the conversation's account, with `In-Reply-To` set to its `Message-ID` and `References` to its parent and itself, subject `Re: …`. Once sent it joins the conversation as an outgoing message, so an answer to it matches by thread.
- **Uncertain outcomes.** As for campaign sends: `executing` before the call, reconciliation by `Message-ID`, never re-sent blindly. An `unknown` reply is retried only through reconciliation; when that gives up it appears under Needs attention as "Reply from the inbox". "It was sent" records it in the conversation; "It was not sent" marks it failed and sends nothing — the user sends it again from the inbox.
- **One at a time.** While a reply in a conversation is `sending` or `unknown`, another one there is refused (`reply.pending`): a second message while the first may be on its way could be a duplicate in the person's eyes.
- **Retention.** The body of a settled reply (`sent`, `failed`) is blanked with message texts (docs/18); one still sending or uncertain keeps it.

## Alternatives

- **Route replies through the campaign engine** as an ad-hoc enrollment step: reuses the run machinery, but drags in approvals, caps and windows that do not fit a direct answer, and mixes inbox mail into campaign statistics and the CSV export.
- **Send directly from the command handler** without a job: simpler, but a crash or sleep mid-send would leave nothing to reconcile from, against CLAUDE.md §3.4.
- **Apply the full contact policy:** the reply hold would block every answer to someone who replied, which is the point of the feature.

## Consequences

- New protocol messages `conversations.reply` and `conversations.retryReply`; `conversations.get` adds `replyTarget` and the replies not yet sent; `sideEffects.uncertain` items carry `source: campaign | reply`.
- New audit action `message.reply` (`planned | completed | failed | unknown`, object the conversation), shown on the contact's timeline with the text once sent.
- `OutgoingMessage` gains optional `inReplyTo` / `references`; both email channels pass them to the MIME composer. Threaded campaign follow-ups (docs/17 `replyAsThread`) can reuse this.
- Gmail API sends do not set `threadId` yet: the recipient's mail client threads the reply by its headers, while the sender's Gmail may show it apart from the thread. Setting `threadId` comes with threaded follow-ups.
- An AI suggestion for the reply text (`conversations.draftReply`, prompt `reply.suggest`, docs/15) only fills the editor; it never sends and stores nothing besides the usual AI call log.

## Migration impact

Migration 20 adds `manual_replies`; nothing existing changes.
