# 09 — Browser Instrumentation

## Purpose

Instrumentation makes browser automation observable and controllable to the user.

The product must show what the automation is doing rather than hiding activity behind an opaque agent.

## Instrumentation layers

### Worker event stream

Every browser task and action emits events to core, which records them as action events:

```text
task.started
task.progress
action.target_resolved        (incl. resolution method: pack | semantic_locator | text | ai_choice)
action.completed
action.failed
action.verification_unknown
session.paused
session.human_control_acquired
session.human_control_released
challenge.detected
state.unsupported
```

### In-page overlay

Injected by the worker (see `12-IN-PAGE-OVERLAY.md`). Displays:

- current workflow and prospect;
- intended action;
- highlighted target;
- in `assisted` mode: "Please review and click the highlighted button";
- in `manual` mode: prepared content with a copy button;
- warning when a critical action is waiting for approval in the app;
- a **Pause** button.

The overlay never offers resume, return-control or approve. Those are desktop-app actions only, because anything inside the page can be triggered by the page itself.

Overlay must not cover critical page controls unnecessarily and must be collapsible.

## Target highlighting

Before a critical browser action, the worker highlights the resolved element through the overlay. In `auto` mode the highlight is explanatory; in `assisted` mode it is the instruction to the user.

Approval views in the desktop app show the screenshot captured at `Prepare*` with the target highlighted.

## Sensitive-field policy

Instrumentation must not:

- display stored secrets;
- capture password values;
- retain full credit-card/payment forms;
- send DOM or accessibility snapshots to an AI provider without redaction and task need.

## Timeline

The user-visible timeline combines domain and worker events:

```text
10:41:03  Opened profile "LinkedIn – Anna"
10:41:08  Opened prospect profile
10:41:10  Verified identity: Jane Doe (linkedin.com/in/jane-doe)
10:41:11  Checked conversation: no new replies
10:41:14  Prepared message (assisted)
10:41:14  Waiting for approval
10:42:02  Approved by user
10:42:03  Opened composer, filled message, highlighted Send
10:42:09  User clicked Send
10:42:10  Verified sent state
```

## Screenshots

Default screenshot policy:

- on failure;
- on human intervention request;
- at every `Prepare*` task for critical actions (shown in approval view);
- after critical actions for verification evidence;
- manual capture.

Screenshots are stored under `artifacts/screenshots/` with a retention setting.

## DOM/accessibility capture

Prefer accessibility snapshots over HTML.

When HTML/DOM capture is necessary:

- redact input values;
- truncate excessive content;
- store only as long as needed for diagnostics.
