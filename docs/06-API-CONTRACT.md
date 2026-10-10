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
command exports.campaign               # { campaignId } -> { filename, csv, rows }; campaign status, one row per person
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
query   retention.get                                                  # { settings, lastRun } — docs/18
command retention.update                                               # days per kind, or null to keep
```

## AI settings

```text
query   ai.settings.get                # provider (anthropic|openrouter|openai), models per use case, prices, budget, keySet, keyHint (last four characters), keys per provider
command ai.settings.update
command ai.setKey / ai.removeKey       # per provider; the key is stored encrypted and never returned
command ai.testKey                     # one minimal call with the classification model
query   ai.usage                       # { month } -> calls, tokens, estimated cost, per use case
```

## Research

```text
command research.start                 # { companyId, criteria? } — needs a website and an AI key
query   research.list                  # { companyId } -> runs, newest first
query   research.get                   # run + facts (verified or not) + evidence (url, title, capturedAt)
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
command campaigns.clone               # { id, name } -> a new draft with the source's draft config; no versions, no people
command campaigns.delete              # { id } -> ok; only a never-launched campaign, else CONFLICT campaign.launched
query   campaigns.preview             # { campaignId, contactId, generate } -> the first action for one contact (dry run)
```

Launch validation fails with `VALIDATION_FAILED` and field keys such as `steps.0.body: template.unknownField`;
state errors are `CONFLICT` (`campaign.notLaunched`, `enrollment.notActive`, …).

## Drafts and approvals

```text
query   approvals.pending              # batch queue, oldest first; each with origin, draft checks and the facts used
command approvals.approve              # { approvalId, contentHash }  -- hash must match current draft
command approvals.reject               # stops the enrollment
command approvals.skip                 # this message is not sent; the enrollment moves to its next step
command drafts.revise                  # new draft version, supersedes open approvals, returns the new one
                                       # (null for a website form: it is prepared again, a new approval follows)
query   drafts.history                 # { draftId } -> every version of that message, newest first, with origin
```

Approval commands re-check the exact target and content hash and fail with `APPROVAL_STALE` on mismatch; deciding an approval that is no longer pending is `CONFLICT` (`approval.notPending`). `drafts.revise` is refused (`draft.alreadySent`) once the send is `executing`, `completed` or `unknown` in the ledger: an edit must never lead to a second message.

## Interventions and reconciliation

Implemented under **Browser profiles** below (`interventions.list`, `interventions.resolve`, `profiles.takeControl`, `profiles.returnControl`) and **Unconfirmed sends** (`sideEffects.uncertain`, `sideEffects.resolve { id, outcome: completed | not_sent }`); "not sure" is leaving a send undecided.

## Activity and UI settings

```text
query   activity.list                  # { contactId? | companyId? | campaignId?, category?, before?, limit } -> { items, hasMore }, newest first; each item names its contact, company and campaign and carries the message text for sends, AI drafts and replies
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
command accounts.connectGmail          # { clientId, clientSecret? } -> consent in the system browser, loopback via main (host: oauth.loopback)
query   sideEffects.uncertain          # sends whose outcome is unknown (or stuck executing), with `checking` while a job still looks
command sideEffects.resolve            # { id, outcome: completed | not_sent } — refused while a send job for the run is active
query   contacts.replyHold             # replied | company_replied | null
command contacts.releaseReplyHold      # campaigns may write again; earlier replies stop counting
```

## Inbox

```text
query   conversations.list             # { filter: all | unread | review } -> items, total, unread count
query   conversations.get              # summary + messages (outbound and inbound) + replyTarget + replies not yet sent (ADR 031)
command conversations.markRead
command conversations.review           # { messageId, decision: confirm | dismiss } for a possible (domain-only) reply
command conversations.reply            # { conversationId, messageId, subject, body } + idempotency key -> ManualReply; sent by a job through the ledger (ADR 031)
command conversations.retryReply       # { id } -> ManualReply; only a failed reply, same intent
command conversations.draftReply       # planned, Phase 8d: AI suggestion that only fills the editor
```

## Browser profiles (Phase 5a)

```text
query   profiles.list                  # { includeArchived } -> profiles with their live session and last health
command profiles.create                # { name, purpose: general | research }
command profiles.update / profiles.archive
command profiles.delete                # { id, confirmName } — closed profiles only; the name must match exactly
command profiles.open                  # { id, startUrl? } — visible Chrome, control mode `human`
command profiles.close / profiles.focus / profiles.check
command profiles.checkSignIn          # { id, packId: linkedin } — opens under automation, recognizes the site's page (Phase 5b)
command profiles.takeControl           # { id } — the person takes over an automated window; the work waits (Phase 5c)
command profiles.returnControl         # { id } — hand back; the work checks the page again first
query   app.control.get                # { paused, pausedAt, emergencyStoppedAt, keepAwake }
command app.pauseAll / app.resumeAll   # no new external action while paused; reading replies goes on
command app.emergencyStop              # pause, and the worker stops every browser task at once
command app.setKeepAwake               # { keepAwake } — keep the Mac awake while a campaign is active
query   packs.health                   # per pack version, 30 days: tasks, unsupported, needsHuman, unknown (Phase 7c)
query   linkedin.settings.get          # { enabled, profileId, riskAcknowledgedAt, autoConnect, autoMessage, limits, limitsRaised } (Phase 7b)
command linkedin.settings.update       # + acknowledgeRisk; errors linkedin.riskRequired | profileRequired | limitsRaiseRequired
query   forms.sender.get               # { profileId, name, email, phone, company, website } (Phase 6b)
command forms.sender.update            # the research profile is refused (forms.profileUnsuitable)
query   forms.screenshot               # { approvalId } -> { png: base64 | null } — the prepared form
query   interventions.list             # open requests to the person, with diagnostics of unrecognized pages
command interventions.resolve          # { id, outcome: done | cancel } — done checks again in the same window
```

`data.changed` carries `browser` when a profile or session changes. Errors: `profile.alreadyOpen`, `profile.open`, `profile.inUse`, `profile.openFailed`, `profile.nameMismatch`, `profile.notOpen`, `profile.inUseByYou`, `profile.checking`, `profile.research`, `profile.formSender`, `profile.linkedinAccount`, `session.nothingToReturn`, `session.notOpen`, `session.busy`, `intervention.notFound`, `intervention.closed`, `chrome.missing`, `worker.notRunning`. Worker → core: `session.modeChanged { sessionId, controlMode, by: overlay | challenge | emergency_stop }`; core → worker: `session.setOverlay`, `worker.emergencyStop`; core → main: `power.keepAwake`, `app.notify`; main → core: `control.fromTray`.

## Jobs and diagnostics

```text
query   jobs.needsAttention            # dead/failed jobs
command jobs.retry / jobs.dismiss
query   diagnostics.screenshots        # masked screenshots kept for browser tasks (30 days), codes only
command diagnostics.createBundle       # { screenshots } -> { filename, base64, bytes, contents } (docs/20)
query   app.health                     # implemented: versions, core/worker/Chrome health for the status screen
```

## App-wide commands

Implemented (Phase 5c) under **Browser profiles**: `app.control.get`, `app.pauseAll`, `app.resumeAll`, `app.emergencyStop`, `app.setKeepAwake`. First-run setup (Phase 8c, FR-APP-002):

```text
query   setup.get                      # -> { chrome, aiKeySet, emailAccounts, profiles, completedAt }
command setup.complete                 # finished or skipped: the start page no longer opens the setup
```

The start page (`#/`) opens the setup while it is not finished and nothing is configured; Settings → General opens it again. The steps use the ordinary settings commands.

Implemented in Phase 8b (ADR 029):

```text
query   backup.list                    # -> { items: [{ name, kind, createdAt, bytes, schemaVersion }], lastRestore, schemaVersion }
command backup.create                  # manual backup in data/backups/
command backup.delete { name }         # a backup file by name (never a path)
command backup.restore { name }        # checked now, applied by a core restart; the app starts paused
command backup.exportPortable          # main's save dialog (host `file.chooseSavePath`), then core writes a copy without secrets
```

Versions are part of `app.health`.

These are app-channel requests handled by **core**, like all renderer requests. Where an Electron capability is needed (keep-awake via `powerSaveBlocker`, file dialogs), core asks main over the host channel. The host channel is bidirectional: main sends core `power.suspend` / `power.resume` from `powerMonitor` (implemented): core stops claiming jobs while the Mac sleeps and, on wake, resumes and re-plans overdue work into the active windows.

## Events

Events are one-way hints validated against the event registry (`packages/protocol/src/events.ts`); receivers refetch authoritative state. The renderer subscribes through `window.tabreach.subscribe`.

Implemented:

```text
data.changed   { entities: ('company'|'contact'|'suppression'|'activity'|'settings'|
                            'job'|'campaign'|'enrollment'|'approval'|'account'|'conversation'|
                            'research'|'browser')[] }   # after every mutation
```

Background work announces its changes the same way: a failed or dead job sends `job`, a new approval sends `approval`, a sent message sends `enrollment`.

Browser worker requests beyond Phase 5b: `task.run { taskType: commit }`, `task.checkpoint` (worker → core, Phase 5c), `task.cancel { taskId }` and `task.render { taskId, sessionId, url, site }` → `{ status: ok | challenge | blocked | failed, url, title, html, reason }` (Phase 5d). The full list is in docs/07.

Replies need no event of their own: an arriving reply sends `data.changed { conversation }`. Browser changes need none either: a request to the person or a session change sends `data.changed { browser }` (the separate events once planned were dropped).

Core availability is not an event: main reports it through `onCoreState` (ADR 020).
