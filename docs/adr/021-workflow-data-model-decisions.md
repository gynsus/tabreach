# ADR 021 — Workflow engine data model decisions

**Status:** Accepted (2026-09-28, before Phase 2). Refines docs/05, 13, 17 and ADR 018.

## Context

The Phase 1 audit listed questions the docs left open or answered twice; Phase 2 code would otherwise decide them implicitly. This ADR settles them. `docs/05-DATABASE-SCHEMA.md`, `13-WORKFLOW-ENGINE.md` and `17-CAMPAIGNS.md` are updated to match.

## Decisions

### 1. Who owns time: enrollment vs workflow run
- **CampaignEnrollment owns the gap between steps**: `next_action_at` is when the next step may start (delay after the previous step's *actual* completion, adjusted to the recipient's active window).
- **WorkflowRun owns waiting inside one step**: `WAITING_APPROVAL`, `WAITING_FOR_HUMAN`, `WAITING_EXTERNAL`. `WAITING_DELAY` is removed from WorkflowRun statuses.

### 2. Who owns retries: jobs vs workflow runs
- **Jobs own execution retries** (`attempts`, `max_attempts`, backoff via `run_at`, `dead`). `workflow_runs` has no `retry_count` / `next_attempt_at`.
- Job terminal states: `succeeded`; `failed` = non-retryable error class (the workflow decides what it means); `dead` = retries or max age exhausted (shown in "Needs attention").
- Each job type is registered with `sideEffecting: boolean`. On startup, expired leases of **non-side-effecting** jobs return to `pending`; **side-effecting** ones go to reconciliation through the side-effect ledger, never straight to re-execution.
- Lease: 60 s, renewed every 20 s by long handlers; `lease_owner` = the core process instance id (UUID generated at core start).

### 3. Side-effect ledger (refines ADR 018)
- Statuses: `reserved | executing | completed | not_sent | unknown`.
  - `not_sent`: verified that nothing reached the recipient — the attempt was rejected before submission (`error_class` says why), or reconciliation proved absence. **Re-execution of the same intent is allowed only from `not_sent`.**
  - `unknown` resolves only via reconciliation (`provider_lookup | ui_verification | user_confirmation`) to `completed` or `not_sent`.
  - "Failed" is an action-event status (what the audit trail reports about an attempt), not a ledger status; ADR 018's `failed` is replaced by `not_sent` + `error_class`.
- Key format: `sha256` hex of `v1|<enrollment or standalone workflow id>|<step position>|<channel>|<action type>|<normalized target>`; the readable parts are also stored in columns for inspection.
- `side_effects.workflow_run_id` is the run that **first reserved** the key (nullable FK, `ON DELETE SET NULL`). A new WorkflowRun for the same step finds the existing ledger row by key and follows the rules above; it never creates a second row.

### 4. Approvals
- An approval is a **row with a lifecycle**: `pending → approved | rejected | skipped | superseded | expired`.
- Created `pending` when a workflow reaches `CHECK_APPROVAL`; it references the **draft version** (`message_draft_id`, `draft_version`) and the target snapshot and content hash.
- A draft edit sets pending/approved approvals for that draft to `superseded` and creates a new `pending` one. Decisions are separate audit events.
- `APPROVAL_STALE` is checked in two places: when the user approves (hash must match the current draft) and in the final pre-send check (hash of what is about to be sent must match the approved hash).
- `approvals.pending` lists `pending` rows; the renderer is notified through `data.changed { entities: ['approval'] }` (event entity added in Phase 2).

### 5. Status enums
- `campaigns.status`: `draft | active | paused | archived`.
- `campaign_enrollments.status`: `active | paused | completed | stopped` (+ `stop_reason`).
- `workflow_runs.status`: `pending | running | waiting_approval | waiting_for_human | waiting_external | paused | completed | failed | cancelled`.
- `workflow_step_runs.status`: `running | succeeded | failed`.
- `jobs.status`: `pending | running | succeeded | failed | dead`.

### 6. Contact policy definitions
- **Touch** = a side effect toward a contact/company with status `executing`, `completed` or `unknown` (conservative: an uncertain send counts).
- Default caps (settings key `policy`, editable): 1 touch per contact per 3 days; 3 touches per company per 7 days; company-level stop on reply enabled.
- Default active window: Monday–Friday 09:00–18:00 in the recipient's timezone (contact → company → campaign timezone); per-campaign override.
- Minimum spacing per channel account: email 60 s (browser channels set theirs in adapter packs).
- Domain suppression matches the domain **and its subdomains** (`acme.com` blocks `j@mail.acme.com`); email suppression matches the exact normalized address; company suppression matches the company and all its contacts.
- Suppression, caps and stop conditions are checked in the final pre-send step inside the same transaction that reserves the ledger entry.

### 7. Test channel and conditions (Phase 2 scope)
- The test channel adapter writes to `test_channel_deliveries (id, idempotency_key, target, content_hash, created_at)` and supports forced outcomes (`completed | not_sent | unknown`, delay) for recovery tests. It has one built-in channel account with configurable limits.
- `condition` steps use a minimal predicate list: `{ field, op, value }` with `op ∈ eq | neq | exists | not_exists | contains`, over an enumerated set of prospect and research fields; conditions are ANDed. Richer expressions are out of MVP.

### 8. Drafts
- `message_drafts.contact_id` becomes nullable with a check that contact or company is present (web-form steps target companies).

## Implementation notes (Phase 2, 2026-09-28)

Decisions made while implementing, consistent with the above:

- **Crash recovery of side-effecting jobs.** Every orphaned job returns to `pending`; a side-effecting handler cannot re-execute blindly because it goes through `executeSideEffect`, which finds the ledger row in `executing`/`unknown` and reconciles with the channel first. The guarantee of §2 lives in the ledger, not in the queue.
- **Continuing is not retrying.** A handler may return `{ continueAt }` (outside the send window, cap reached, channel spacing): the job goes back to `pending` without spending an attempt, and never sooner than one second from now.
- **Final pre-send check.** `SideEffectLedger.reserve` takes a guard that runs in the reserving transaction; the workflow passes suppression, caps, stop conditions, channel pacing and the approval-hash check through it.
- **Caps count every touch**, including follow-ups of the same campaign: with the default 1 touch per contact per 3 days, a follow-up after 1 day waits until the cap allows it.
- **Skip vs reject.** `skipped` means "do not send this message" and the enrollment continues with its next step; `rejected` stops the enrollment.
- **Recipient change after approval.** The content hash covers channel, target, subject and body; if the contact's address changes after approval, the final check writes a new draft version and asks again.
- **Columns added** to the documented shape: `campaign_enrollments.campaign_id`, `workflow_runs.step_position`, `message_drafts.workflow_run_id`. `side_effects.workflow_run_id` has no foreign key (the table predates `workflow_runs`).

## Audit 3.5 changes (2026-09-28)

- **Reply hold.** A strong reply (thread or contact address; a confirmed possible reply for companies) puts the contact — and, with the company stop on, their colleagues — on hold for every campaign: the final pre-send check stops (`replied` / `company_replied`) and `campaigns.enroll` skips them (`onHold`). The user lifts it per contact (`contacts.releaseReplyHold`); replies before that moment stop counting.
- **Fresh reads in the final check.** The guard in the reserving transaction re-reads the run, enrollment, campaign and approval; reconciliation may have awaited in between.
- **One unresolved attempt per step.** If another ledger row of the same step (another target, i.e. the address changed) is `executing`/`unknown`, the step waits for a person; if it is `completed`, the step is done.
- **After the channel acted, a ledger conflict is permanent** (`ledger_conflict`): the job fails instead of retrying, which could send again.
- **People decide only when nothing is running.** `sideEffects.resolve` is refused while a send job for the run is pending or running. Every `unknown` (and orphaned `executing`) row is listed by `sideEffects.uncertain`, whatever happened to its job. A run whose job failed or died is not revived by `resync`.
- **Inbox before send.** Email sends read the account's inbox first when the last check is older than 5 minutes, and wait when it cannot be read for 30 minutes.
- **Launching changes of a paused campaign keeps it paused.** A failed condition with `skip` leaves out the step it guards.

## Consequences

- Phase 2 migrations implement these tables and CHECK lists directly.
- One owner per concern: no duplicated retry or delay fields to drift apart.
- The re-execution rule is testable as a single invariant: only from a verified not-sent state.
