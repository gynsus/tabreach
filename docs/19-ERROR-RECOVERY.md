# 19 — Error Recovery

## Goal

Failures must be explicit, diagnosable and resumable.

## Error taxonomy

### `TRANSIENT`

Examples: network timeout, provider 5xx/429, page load timeout, browser page crash.

Policy: bounded retry with backoff — **only** if the operation is idempotent or the side-effect ledger proves nothing was sent.

### `AUTH_REQUIRED`

Examples: LinkedIn login page, expired browser session, OAuth refresh failure, IMAP auth failure.

Policy: human intervention (re-login in the profile / reconnect account).

### `SECURITY_CHALLENGE`

Examples: CAPTCHA, 2FA, unusual-login confirmation.

Policy: human intervention, no automated bypass.

Implemented (Phase 5b): the generic pack recognizes reCAPTCHA, hCaptcha, Cloudflare Turnstile and Arkose frames, one-time-code fields and "verify you are human" texts (EN/RU); channel packs add their own (LinkedIn checkpoint). A challenge is matched before any other state.

### `TARGET_MISMATCH`

Expected prospect/page identity does not match the current page.

Policy: stop the critical action and request review.

### `UNSUPPORTED_STATE`

The page does not match any expected adapter-pack state.

Policy:

1. bounded semantic observation if the step allows it and the action is not the final critical target in `auto` mode;
2. otherwise human intervention;
3. diagnostics (screenshot + accessibility snapshot) are kept to update the adapter pack.

### `OUTCOME_UNKNOWN`

A critical action may or may not have happened.

Policy: reconciliation (provider lookup → UI verification → user confirmation). Never an automatic retry.

### `POLICY_BLOCKED`

Action is not allowed by approval/contact/channel/global policy.

No retry.

### `PERMANENT`

Invalid email, hard bounce, deleted target, unsupported provider action.

No retry unless the user changes inputs.

## Browser worker crash / Chrome crash

1. main detects worker exit (or worker detects Chrome disconnect);
2. core marks the session `interrupted` and running tasks `interrupted`;
3. main terminates orphaned Chrome processes;
4. worker is restarted (bounded backoff);
5. for each interrupted task, look at the last persisted checkpoint:
   - before `about_to_commit` → safe to re-run the task from the start (re-open, re-verify);
   - at/after `about_to_commit` → side effect is `executing`; run reconciliation, never re-execute blindly;
6. resume.

## Core crash / app quit

1. On restart, core runs migrations check and opens the DB.
2. Jobs with expired leases are recovered per type (see `13-WORKFLOW-ENGINE.md`).
3. Side effects in `executing` are moved to `unknown` and reconciled.
4. Browser sessions from the previous run are marked ended; profiles are re-opened on demand.

## Sleep/wake

- On `suspend`: stop claiming jobs; running browser tasks continue only to the next safe point, then pause.
- On `resume`: network may be down for a while — the first failures are `TRANSIENT`; the scheduler re-plans overdue actions per `17-CAMPAIGNS.md` (no burst).
- A browser task interrupted by sleep is handled like an interrupted task (checkpoint rules above).

## Duplicate prevention

Before repeating a critical action:

- check the side-effect ledger for the logical intent key;
- email: search Sent for the app-generated `Message-ID` (Gmail `rfc822msgid:`, IMAP `SEARCH HEADER Message-ID`), with several delayed attempts because provider search indexing lags. With generic SMTP a Sent copy may not exist (sending and `IMAP APPEND` are separate operations), so `unknown` is a normal, expected outcome there;
- LinkedIn: inspect the thread / pending-invitation state;
- forms: ask the user;
- compare content/recipient.

If still uncertain whether the action occurred, keep it `unknown` and request human review rather than acting again.

## Dead jobs

Jobs exceeding retry policy become `dead` with:

- job ID;
- correlation ID;
- error class;
- attempt count;
- last error (redacted);
- workflow reference.

The desktop app shows dead jobs in a "Needs attention" view with retry/dismiss.

## Global pause and emergency stop

- Global pause: stop scheduling new external actions; in-flight tasks reach a safe point (before `about_to_commit`) and stop.
- Emergency stop: worker aborts all Playwright operations immediately and sets all sessions to `paused`; any task past `about_to_commit` becomes `unknown` and is reconciled later.

Implemented (Phase 5c-1): the state is the setting `app.control` (survives restarts). While paused, the campaign engine's final pre-send check defers the send by a minute (`app.paused`) — nothing is lost and nothing is sent — and browser workflows do not start their next step; reading the inbox goes on so replies still stop sequences. Emergency stop additionally calls `worker.emergencyStop`, which aborts every running task and pauses every automated session; if the worker does not answer, the app is paused anyway. Controls: Status → Control, the banner on every screen, and the tray. Keep-awake (FR-APP-004) holds a `prevent-app-suspension` power blocker only while it is on, a campaign is active and nothing is paused.

## Recovery testing

Tests must simulate:

- worker crash before a critical action;
- worker crash after the click but before verification;
- core crash between ledger `executing` and result;
- network failure during email send (reconciled via Message-ID, or left `unknown` — never re-sent automatically);
- duplicate job execution attempt;
- expired browser login;
- challenge page;
- user manually completes the intended action during takeover;
- assisted-mode timeout;
- suspend/resume with overdue scheduled actions.
