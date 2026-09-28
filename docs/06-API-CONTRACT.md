# 06 — App Protocol (Renderer ↔ Core)

There is no HTTP API. The renderer talks to core through a `MessagePort` (brokered by main, exposed via the preload bridge). This document defines the **app protocol**. The **browser protocol** (core ↔ worker) is in `07-BROWSER-RUNTIME.md`.

## Principles

- Messages use the envelope from `03-SYSTEM-ARCHITECTURE.md`. Kinds: `command` (mutates), `query` (reads), `result`, `event` (one-way hint).
- Names are `<area>.<verb>` for commands/queries and `<area>.<past_tense>` for events.
- Every message type has a Zod schema in `packages/protocol` (`messages.ts` for requests, `events.ts` for events); types are inferred from them.
- Commands that create records accept an `idempotencyKey` (envelope field). The renderer generates one per user intent and reuses it on retry; core returns the first result for a repeated key (ADR 020).
- Commands that trigger external side effects never execute them synchronously; they create workflows/jobs and return their IDs. The diagnostic `browser.launchCheck` is the one exception: it runs a throwaway Chrome check and waits for it.
- Core never sends user-facing sentences: failures carry codes and message keys, which the renderer translates.

## Preload bridge (`window.tabreach`)

```text
invoke(type, payload, { idempotencyKey? }) -> { ok: true, data } | { ok: false, error }
subscribe(eventType, listener) -> unsubscribe          # survives core restarts and reloads
onCoreState(listener) -> unsubscribe                   # 'starting' | 'running' | 'restarting' | 'failed'
saveTextFile({ suggestedName, content }) -> { saved, path? }   # main shows the save dialog
```

Only app-channel request types are accepted by `invoke`; host (core → main) and browser (core → worker) messages are not addressable from the renderer. While core is down, requests fail fast with `UNAVAILABLE` instead of waiting for their timeouts; when core returns, the renderer refetches everything because events sent meanwhile are lost.

## Result shape

Success: `{ "ok": true, "data": { } }`

Failure (problem-details style):

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "title": "Validation failed",
    "detail": "optional technical detail",
    "fields": { "email": "email.duplicate" }
  }
}
```

`fields` maps a field name to a **message key**, not text. Keys without a matching form field (e.g. `id: contact.notFound`) are shown as a form-level message. Do not expose stack traces or secrets in results. Stable codes are listed in `25-DEVELOPMENT-CONVENTIONS.md`.

## Prospects

```text
query   companies.list / companies.get
command companies.create / companies.update
query   contacts.list / contacts.get
command contacts.create / contacts.update
command imports.prospects.preview      # { csv } -> headers, sample rows, row count, suggested mapping
command imports.prospects.commit       # { csv, mapping[], onMatch: skip | fill_empty | overwrite }
command exports.prospects              # -> { filename, csv }; the renderer then calls saveTextFile
```

The renderer reads a user-chosen file with the File API (`<input type="file">`) and sends its text
(max 20 MB). Exports go the other way through the preload's `saveTextFile({ suggestedName, content })`,
which asks main to show the native save dialog (`tabreach:save-text-file`, sender-checked,
schema-validated). The renderer never gets filesystem access.

Import semantics (FR-PROS-003..005): the whole file is one transaction. Companies match by domain,
then by name among companies without a domain; contacts by email, then LinkedIn profile, then name
within the same company. Row errors carry a translatable reason key (`email.invalid`, `row.empty`, …)
and the spreadsheet row number; blank rows are skipped. Exports use column names the importer maps
back automatically, prefix custom fields with `company:` / `contact:`, guard against formula injection
and start with a UTF-8 BOM.

## Contact policy

```text
query   suppressions.list
command suppressions.add / suppressions.remove / suppressions.import   # add is idempotent
query   policy.settings.get                                            # caps, active window, company stop
command policy.settings.update
```

## Research

```text
command research.start                 # { targetType, targetId, mode }
query   research.get
query   evidence.listForTarget
```

## Campaigns

```text
query   campaigns.list / campaigns.get
command campaigns.create / campaigns.update / campaigns.archive
command campaigns.launch               # creates immutable version, validates channels/templates/timezone
command campaigns.pause / campaigns.resume
command campaigns.enroll               # { campaignId, contactIds[] } — idempotency key; skips duplicates
query   enrollments.list               # { campaignId } — step, next action, what it waits for
command enrollments.pause / enrollments.resume / enrollments.stop
command campaigns.clone / campaigns.preview   # Phase 2c
```

Launch validation fails with `VALIDATION_FAILED` and field keys such as `steps.0.body: template.unknownField`;
state errors are `CONFLICT` (`campaign.notLaunched`, `enrollment.notActive`, …).

## Drafts and approvals

```text
query   approvals.pending              # batch queue, oldest first
command approvals.approve              # { approvalId, contentHash }  -- hash must match current draft
command approvals.reject               # stops the enrollment
command approvals.skip                 # this message is not sent; the enrollment moves to its next step
command drafts.revise                  # new draft version, supersedes open approvals, returns the new one
```

Approval commands re-check the exact target and content hash and fail with `APPROVAL_STALE` on mismatch; deciding an approval that is no longer pending is `CONFLICT` (`approval.notPending`). `drafts.revise` is refused (`draft.alreadySent`) once the send is `executing`, `completed` or `unknown` in the ledger: an edit must never lead to a second message.

## Browser profiles and sessions

```text
query   browserProfiles.list / browserProfiles.get
command browserProfiles.create / browserProfiles.update
command browserProfiles.open / browserProfiles.close / browserProfiles.healthCheck
command browserProfiles.delete         # requires { confirmName } equal to profile name
query   browserSessions.list / browserSessions.get
command browserSessions.pause / browserSessions.resume
command browserSessions.takeControl / browserSessions.returnControl
command browserSessions.focusWindow
```

## Interventions and reconciliation

```text
query   interventions.open
command interventions.resolve          # { interventionId, outcome, notes }
                                       # outcome e.g. 'action_completed_by_user' | 'not_done' | 'unknown'
```

## Activity and UI settings

```text
query   activity.list                  # { objectType?, objectId?, limit } -> newest first
query   settings.ui.get                # -> { language: 'en' | 'ru' }
command settings.ui.update
```

## Validation errors

`VALIDATION_FAILED` results carry `fields`: field name -> message key (e.g. `{ "email": "email.duplicate" }`).
Keys, not sentences: the renderer translates them (`errors.*` in the i18n catalogs, ADR 019).

## Channel accounts

```text
query   accounts.list                  # email accounts; never includes secrets
command accounts.connectImap           # { address, smtp, imap, username, password, limits } — tested before saving
command accounts.update                # name, sender name, limits, new password (tested before saving)
command accounts.test                  # SMTP + IMAP check, reports the Sent folder
command accounts.disconnect            # deletes the stored password
command accounts.connectGmail          # Phase 3b: { clientId, clientSecret? } -> OAuth loopback via main
command sideEffects.resolve            # { id, outcome: completed | not_sent } — a person settles an unknown send
```

## Inbox

```text
query   conversations.list             # { filter: all | unread | review } -> items, total, unread count
query   conversations.get              # summary + messages (outbound and inbound)
command conversations.markRead
command conversations.review           # { messageId, decision: confirm | dismiss } for a possible (domain-only) reply
command conversations.draftReply       # Phase 4 (AI drafting)
```

## Jobs and diagnostics

```text
query   jobs.needsAttention            # dead/failed jobs
command jobs.retry / jobs.dismiss
command diagnostics.createBundle       # main shows the save dialog
```

## App-wide commands (Phase 2+)

```text
command app.globalPause / app.emergencyStop
command app.setKeepAwake
query   app.versions                   # app, Electron, Chrome, adapter packs
command app.backupDatabase
```

These are app-channel requests handled by **core**, like all renderer requests. Where an Electron capability is needed (keep-awake via `powerSaveBlocker`, file dialogs), core asks main over the host channel. The host channel is bidirectional: main sends core `power.suspend` / `power.resume` from `powerMonitor` (implemented): core stops claiming jobs while the Mac sleeps and, on wake, resumes and re-plans overdue work into the active windows.

## Events

Events are one-way hints validated against the event registry (`packages/protocol/src/events.ts`); receivers refetch authoritative state. The renderer subscribes through `window.tabreach.subscribe`.

Implemented:

```text
data.changed   { entities: ('company'|'contact'|'suppression'|'activity'|'settings'|
                            'job'|'campaign'|'enrollment'|'approval')[] }   # after every mutation
```

Background work announces its changes the same way: a failed or dead job sends `job`, a new approval sends `approval`, a sent message sends `enrollment`.

Planned with their phases: `email.reply_received` (Phase 3), `browser.intervention_required` and `browser.session_changed` (Phase 5).

Core availability is not an event: main reports it through `onCoreState` (ADR 020).
