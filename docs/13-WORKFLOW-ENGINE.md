# 13 — Workflow Engine

## Goal

All non-trivial asynchronous workflows are explicit, persistent state machines in core, backed by SQLite.

No important external automation is represented as an unpersisted chain of promises.

## Workflow properties

A workflow must be:

- resumable (after app restart, worker crash, Mac sleep);
- observable;
- idempotent across retries;
- bounded in retries;
- able to wait hours/days;
- able to wait for human input;
- versioned.

## Durable job queue (ADR 011)

Core owns a `jobs` table. There is no external broker.

- **Enqueue** happens in the same SQLite transaction as the state change that requires it. This removes the dual-write problem (no outbox needed).
- **Claim**: a single dispatcher loop in core selects due jobs (`status='pending' AND run_at <= now`) ordered by `run_at`, sets `status='running'`, `lease_owner`, `lease_until` in one transaction. Since core is the only writer, no cross-process locking is needed; the lease exists to detect jobs orphaned by a crash.
- **Wake-up**: the dispatcher sleeps until the earliest `run_at` (bounded, e.g. max 30 s) and is woken immediately on enqueue. No busy polling per enrollment.
- **Concurrency**: per job type limits (e.g. research ×3, browser tasks ×1 per profile, email sends ×1 per account).
- **Completion**: result and next-state persisted, job marked `succeeded`/`failed`, follow-up jobs enqueued — one transaction.
- **Retry** (jobs own retries, ADR 021 §2): a retryable error → `pending` with `run_at` = backoff; a non-retryable error → `failed`; after `max_attempts` or max age → `dead`, logged as `jobs.dead` and shown in Needs attention.
- **Leases**: 60 s, renewed every 20 s by long handlers; `lease_owner` is the core instance id.
- **Crash recovery**: every job type declares `sideEffecting`. On startup, expired leases of non-side-effecting jobs go back to `pending`; side-effecting ones go through reconciliation (see Idempotency) — never blindly re-run.
- **Transactions**: `transaction()` nests via SAVEPOINTs, so a service can enqueue a job inside the caller's state-change transaction; callbacks must be synchronous.
- **Sleep**: on `suspend` the dispatcher stops claiming; on `resume` it re-evaluates due jobs against campaign windows (`17-CAMPAIGNS.md`).

## State machine ownership map

Several state machines exist. Exactly one owns each concern; lower levels report facts, upper levels decide transitions.

```text
CampaignEnrollment   owns: which step a prospect is on; stopped/active/completed
   │  creates one per step
   ▼
WorkflowRun          owns: progress of ONE step (WAITING_APPROVAL, WAITING_FOR_HUMAN,
   │                       WAITING_EXTERNAL). Delays BETWEEN steps belong to the enrollment
   │                       (next_action_at); execution retries belong to jobs (ADR 021 §1–2).
   │  dispatches
   ▼
BrowserTask          owns: execution record of one unit of browser work (dispatched..result).
   │                       Reports results; never decides workflow transitions.
   │  runs in
   ▼
BrowserSession       owns: control mode (automation/paused/human) and liveness.
                           Gates task execution; never holds workflow state.

SideEffect (ledger)  owns: whether an external action happened (reserved/executing/
                           completed/not_sent/unknown). Consulted before any critical execution.
HumanIntervention    owns: an open request to the user and its resolution.
BrowserProfile       owns: profile health/login status.
```

Rules:

- A `task.result` / `challenge.detected` / `session.changed` event updates its own record, then the WorkflowRun handler decides the transition.
- `WAITING_FOR_HUMAN` exists only on WorkflowRun. The session merely becomes `paused`.
- An enrollment advances only when its current WorkflowRun reaches `COMPLETED` (or a terminal state that the step's policy maps to "continue"/"stop").
- Every transition that means something to the user (approval requested or decided, draft written, message planned/sent/failed, enrollment stopped or completed) is persisted with an action event in the same transaction; internal state steps within a run are not.

## Generic workflow statuses

```text
PENDING
RUNNING
WAITING_APPROVAL
WAITING_FOR_HUMAN
WAITING_EXTERNAL
PAUSED
COMPLETED
FAILED
CANCELLED
```

Each workflow type additionally has a domain-specific `current_state`.

## Command processing

```text
load workflow run
check lock_version
validate current state
persist transition intent (+ action event) — transaction 1
perform bounded operation (browser task / provider call) — no transaction held
persist result/next state (+ action event, + follow-up jobs) — transaction 2
emit event to renderer
```

Never hold a database transaction open across browser/network calls.

## Idempotency (ADR 018)

External side effects go through the `side_effects` ledger.

**Idempotency key = logical intent**, derived from:

- enrollment ID (or standalone workflow ID);
- step position;
- channel and action type;
- target identity (normalized email / profile URL / form URL).

The key **does not include the content hash**. Editing a draft after an `unknown` outcome must not produce a new key — otherwise an uncertain send followed by an edit would be sent twice. The content hash is checked separately against the approval.

Protocol for a critical action:

1. `reserve`: insert ledger row (`reserved`); if the key exists:
   - `completed` → skip execution, mark step done;
   - `unknown` / `executing` → reconciliation, never execution;
   - `not_sent` (verified nothing reached the recipient) → allowed to retry;
2. set `executing` **before** the irreversible call (for browser tasks: on the `about_to_commit` checkpoint);
3. execute;
4. verify → `completed` / `not_sent` / `unknown`.

Reconciliation sources: provider lookup (email: search Sent for the app-generated `Message-ID`), UI verification (LinkedIn thread / pending state), user confirmation.

## Error classes and retry

See `19-ERROR-RECOVERY.md` for the taxonomy. Retries require exponential backoff with jitter, maximum attempts and maximum total age.

## Example: LinkedIn follow-up message workflow

```text
OPEN_TARGET
VERIFY_TARGET
CHECK_CONVERSATION_FOR_REPLIES      -- mandatory before follow-ups; reply found -> STOPPED_BY_REPLY
PREPARE_CONTENT
CHECK_POLICY                        -- suppression, caps, windows, kill switch
CHECK_APPROVAL                      -> WAITING_APPROVAL
PREPARE_IN_BROWSER                  -- composer open, recipient verified, text filled, screenshot
FINAL_PRE_SEND_CHECK                -- re-run policy + hash + ledger reserve
SEND (auto) | AWAIT_USER_CLICK (assisted)
VERIFY_SENT
COMPLETE
```

Possible detours:

```text
ANY_STATE -> WAITING_FOR_HUMAN
ANY_STATE -> FAILED
CHECK_APPROVAL -> WAITING_APPROVAL
VERIFY_SENT -> UNKNOWN_OUTCOME -> (reconciliation) -> COMPLETE | FAILED | WAITING_FOR_HUMAN
```

Profile sign-in check (`browser_check`, Phase 5b): `RUN_TASK → COMPLETE`, or `RUN_TASK → WAITING_FOR_HUMAN` (status `waiting_for_human`, with an open `human_interventions` row) `→ RUN_TASK` on the person's Done, or `ENDED` on Cancel, a closed window or a lost worker. Taking control, the overlay's Pause or an emergency stop also moves a running check to `WAITING_FOR_HUMAN` (reason `user_control`); Return control resumes it with a fresh check. While the app is paused the step is postponed, not run (Phase 5c-1).

Campaign message steps (`campaign_message`, Phase 4c): `PREPARE_CONTENT → [GENERATE_DRAFT] → CHECK_POLICY → CHECK_APPROVAL → FINAL_PRE_SEND_CHECK → SEND → COMPLETE`. `GENERATE_DRAFT` runs only for AI steps: it waits for the company's research (starting it if needed, polling every 20 s) and calls the model outside any transaction; the draft is stored only if the run is still in `GENERATE_DRAFT`. A non-retryable AI failure stops the enrollment (`draft_failed`); a retryable one retries the job.

Website form steps (`campaign_message` with channel `web_form`, Phase 6b): `PREPARE_CONTENT → [GENERATE_DRAFT] → CHECK_POLICY → PREPARE_FORM → CHECK_APPROVAL → FINAL_PRE_SEND_CHECK → SEND → COMPLETE`. `PREPARE_FORM` finds, maps, fills and photographs the company's contact form in the sender's profile and stores the preparation with the draft it was made for (`form_preparations`); it awaits outside any transaction and keeps the result only if the run is still in `PREPARE_FORM`. The approval hash covers the draft, the recipient and the prepared form (address, field signature, every value, who presses Send). An edited draft or a form that changed when sending (`form.changed`) goes back to `PREPARE_FORM`; a CAPTCHA that appears when sending in `auto` makes the preparation `assisted` and asks for approval again. No form on the site stops the enrollment (`no_contact_form`). While the person holds the sender's window, preparing and sending wait (two minutes at a time) without using up attempts. Audit 6.5: the final pre-send checks run again at the checkpoint (refused: nothing pressed, the next pass acts on what changed); a company's form is sent once per campaign step (other enrollments of that company complete the step with `form.already_sent`); after three preparations a form is `assisted`; a change of the form sender re-prepares forms waiting for approval.

LinkedIn steps (`campaign_message` with channel `linkedin`, Phase 7b) take the email path without `PREPARE_FORM`; their not-sent outcomes are interpreted by the engine (docs/17) and the ledger's action type is `linkedin.connect` or `linkedin.message`, so limits count per class.

If approval arrives long after `PREPARE_IN_BROWSER` (e.g. next day), the workflow re-runs `OPEN_TARGET` through `PREPARE_IN_BROWSER` before sending; browser state is never assumed to persist across waits.

## Workflow versioning

Persist `definition_version` on each run.

Running workflows continue using the version they started with unless a migration explicitly upgrades them. Old definitions are kept in code until no non-terminal runs reference them.

## Cancellation

Cancellation must:

- stop future scheduled steps and jobs;
- cancel in-flight browser tasks at a safe point;
- not attempt to “undo” already sent external messages;
- record cancellation reason;
- release browser resources where applicable.
