# 11 — Human Takeover and Assisted Execution

## Purpose

Human involvement is a first-class runtime state, used when:

- CAPTCHA appears;
- 2FA is required;
- authentication expires;
- a website requests account/security confirmation;
- the page state is unsupported or automation confidence is insufficient;
- the step's execution mode is `assisted` or `manual`;
- the user explicitly wants control.

## Implementation status (Phase 5b, 2026-09-29)

- `human_interventions` (migration 16) with reasons `security_challenge`, `login_required`, `unsupported_state`. The first user is the profile sign-in check: a challenge or an unrecognized page pauses the session, brings the window forward and lists a request under **Status → Needs you**, with the diagnostics of an unrecognized page.
- **Done** puts the session back under automation and checks again in the same window (the check is the revalidation); **Cancel** closes the window and ends the run; closing the window or losing the worker cancels open requests.
- Take control / return control, the overlay and outcome confirmation come with 5c.

## Implementation status (Phase 5c-1, 2026-09-29)

- **Take control** (Browser profiles, on a window under automation or paused) sets the session to `human`; the worker aborts the running task at once (`task.controlTaken`), and the work waits with a `user_control` request (migration 17). **Return control** resolves that request: the session goes back to automation and the work checks the page again first (for a sign-in check the check itself is the revalidation). A window the person opened has nothing to return to (`session.nothingToReturn`).
- The overlay's **Pause** (docs/12) and an emergency stop pause the session in the worker, which reports `session.modeChanged`; core records `session.paused` and asks the person.
- Every request to the person also sends a native notification; the tray menu offers Show, Pause all, Resume and Emergency stop.
- Outcome confirmation and the `about_to_commit` checkpoint: Phase 5c-2 (below).

## Implementation status (Phase 5c-2, 2026-09-29)

A browser action whose result is not recognized after the checkpoint is `unknown`. The window stays open and paused, and the send is listed under **Status → Needs attention → Unconfirmed sends** with "It was sent" / "It was not sent" (ADR 018 `user_confirmation`). "Not sure" is leaving it undecided: the step waits and nothing is pressed again. "It was not sent" asks first and then lets the step run again from the start, re-validating the page.

## Session control modes

A browser session has exactly one control mode:

```text
automation  — the worker may execute task actions
paused      — no automation actions; user may or may not be interacting
human       — user holds control; automation rejected
```

Transitions:

```text
automation --pause / challenge / needs_human--> paused
automation --takeControl--> human
paused     --takeControl--> human
paused     --resume (desktop)--> REVALIDATING --> automation | paused
human      --returnControl (desktop)--> REVALIDATING --> automation | paused
```

`REVALIDATING` is a transient step, not a stored mode: the session stays `paused` until revalidation passes.

The **workflow** state (`WAITING_FOR_HUMAN` etc.) is owned by the workflow engine, not by the session; see the ownership map in `13-WORKFLOW-ENGINE.md`.

## Control rules

While control mode is not `automation`:

- task actions are rejected by the worker;
- core does not dispatch new tasks for that session;
- heartbeat remains active;
- the desktop UI and overlay clearly show the mode.

Who may change the mode:

- desktop app: pause, resume, take control, return control;
- overlay (in page): **pause only**;
- worker: pause (on challenge/unsupported state).

## Intervention record

Every intervention has:

- reason;
- workflow;
- session;
- requested timestamp;
- resolution timestamp;
- resolution outcome (see reconciliation);
- user note optional;
- post-return validation result.

## CAPTCHA/2FA

The system may detect and notify.

It must not:

- solve CAPTCHA automatically;
- outsource CAPTCHA solving;
- capture OTPs from unrelated sources;
- attempt security-control bypass.

A challenge notification explains what the user needs to do without trying to interpret or solve the challenge.

## Resume validation and reconciliation

After the user returns control (or resumes):

1. inspect current URL/page state against the adapter pack;
2. confirm expected account/profile (logged-in identity matches the channel account);
3. confirm target prospect/workflow state;
4. determine whether the intended action already occurred:
   - LinkedIn message: check the thread for the outbound message;
   - LinkedIn connect: check the profile for "Pending";
   - web form: usually **not determinable** from the page;
5. if not determinable, **ask the user**: "Did you submit/send it?" — `yes` / `no` / `not sure`;
6. reconcile the side-effect ledger (`reconciled_by = ui_verification | user_confirmation`);
7. continue, skip, or keep waiting for intervention.

`not sure` leaves the side effect `unknown`; the step is not retried automatically.

This prevents duplicate sends after manual activity.

## Assisted execution

In `assisted` mode the human action is the normal path, not an exception:

1. the worker prepares the action (target opened and verified, content filled);
2. highlights the final control, focuses the Chrome window, and the app shows a notification;
3. the user reviews and clicks in the page;
4. the worker detects the expected post-action state and verifies it;
5. if the user navigates away, closes the tab, or the timeout expires, the task ends `needs_human` and reconciliation (above) asks for the outcome.

Assisted execution requires an approval under `approve_each` just like `auto`; the user's click is an additional safety gate, not a replacement for approval.

## Manual execution

The system prepares content and opens the target; the overlay shows the content with a copy button; the user performs the action; the app asks for the outcome and records it.

## User experience

Desktop must provide:

- `Take control`;
- `Return to automation`;
- `Pause all` (global pause);
- `Emergency stop`;
- a queue of items waiting for the user's click (assisted) or confirmation;
- bring-to-front action for the relevant Chrome window.
