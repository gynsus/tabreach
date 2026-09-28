# 06 — App Protocol (Renderer ↔ Core)

There is no HTTP API. The renderer talks to core through a `MessagePort` (brokered by main, exposed via the preload bridge). This document defines the **app protocol**. The **browser protocol** (core ↔ worker) is in `07-BROWSER-RUNTIME.md`.

## Principles

- Messages use the envelope from `03-SYSTEM-ARCHITECTURE.md`.
- Three kinds from the renderer: `command` (mutates), `query` (reads), `subscribe` (event stream).
- Names are `<area>.<verb>` for commands/queries and `<area>.<past_tense>` for events.
- Every message type has a Zod schema in `packages/protocol`; request and response types are inferred from them.
- Every command returns a result with `correlationId`.
- Commands that trigger external side effects never execute them synchronously; they create workflows/jobs and return their IDs.
- The preload bridge exposes only `invoke`, `query` and `subscribe`; the renderer cannot address main-only capabilities except the listed `app.*` commands.

## Result shape

Success:

```json
{ "ok": true, "correlationId": "019...", "data": { } }
```

Failure (problem-details style):

```json
{
  "ok": false,
  "correlationId": "019...",
  "error": {
    "code": "VALIDATION_FAILED",
    "title": "Validation failed",
    "detail": "One or more fields are invalid.",
    "fields": { "email": ["Invalid email address"] }
  }
}
```

Do not expose stack traces or secrets in results. Stable codes are listed in `25-DEVELOPMENT-CONVENTIONS.md`.

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
query   policy.settings.get                                            # Phase 2
command policy.settings.update                                         # Phase 2
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
command campaigns.create / campaigns.update / campaigns.archive / campaigns.clone
command campaigns.preview              # dry-run first planned action for one target
command campaigns.launch               # creates immutable version, validates adapters/limits
command campaigns.pause / campaigns.resume
command campaigns.enroll               # { campaignId, targets[] }
command enrollments.pause / enrollments.stop
```

## Drafts and approvals

```text
query   approvals.pending              # batch queue, ordered
command approvals.approve              # { approvalId, contentHash }  -- hash must match current draft
command approvals.reject / approvals.skip
command drafts.revise                  # creates new draft version, invalidates approvals
```

Approval commands re-check the exact target and content hash and fail with `APPROVAL_STALE` on mismatch.

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
query   channelAccounts.list
command channelAccounts.connectGmail   # { clientId, clientSecret? } -> starts OAuth via main
command channelAccounts.connectImap    # { host, port, security, username, auth }
command channelAccounts.test
command channelAccounts.disconnect
```

## Inbox

```text
query   conversations.list / conversations.get / conversations.messages
command conversations.draftReply
command conversations.stopSequence
command conversations.markRead
```

## Jobs and diagnostics

```text
query   jobs.needsAttention            # dead/failed jobs
command jobs.retry / jobs.dismiss
command diagnostics.createBundle       # main shows the save dialog
```

## App (handled by main)

```text
command app.globalPause / app.emergencyStop
command app.setKeepAwake
query   app.versions                   # app, Electron, Chrome, adapter packs
command app.backupDatabase
```

## Events

The renderer subscribes by type. Event envelope as in `03-SYSTEM-ARCHITECTURE.md`.

Initial event types:

```text
workflow.state_changed
approval.created
approval.resolved
browser.session_changed
browser.intervention_required
research.completed
research.failed
email.reply_received
campaign.enrollment_changed
action_event.created
job.dead
app.health_changed
```

Events are notifications; the renderer re-queries for authoritative state after reconnecting (e.g. after a core restart).
