# 07 — Browser Runtime (Browser Worker)

## Purpose

The browser worker is a core subsystem that provides controlled, auditable, resumable interaction with a real browser.

It is not a campaign engine and holds no durable state. It executes **browser tasks** dispatched by core and reports progress, checkpoints and results back.

## Runtime stack

- Node.js code running in an Electron `utilityProcess` (validated in Phase 0, ADR 012). Worker code talks to its host only through a thin host adapter (message channel + lifecycle) so the host type can be swapped;
- Playwright (library, not the test runner) for browser control;
- the user's installed **Google Chrome** via `chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: false })`;
- Playwright's bundled Chromium for tests and fixtures only;
- CDP over pipe (Playwright default for launched browsers) — no remote-debugging TCP port;
- adapter packs (`packages/adapter-packs`) for page-state recognition, locators and verification;
- semantic target resolution through core's AI gateway (ADR 013);
- in-page overlay injected by the worker (ADR 014) — no browser extension.

Chrome is launched visibly. No stealth flags, no `navigator.webdriver` patching, no fingerprint changes (ADR 009). Chrome's "controlled by automated software" indication is accepted.

## Concepts

```text
BrowserProfile      durable identity (directory + metadata)
BrowserSession      a running profile owned by this worker
ControlMode         automation | paused | human
BrowserTask         high-level unit of work from core
PageState           recognized state from an adapter pack
Checkpoint          progress marker reported to core
Observation         structured extraction result
Diagnostic          failure evidence (screenshot, a11y snapshot, ...)
```

## Browser protocol (core ↔ worker)

Messages use the common envelope. Families:

```text
# core -> worker (commands)
profile.open / profile.close / profile.healthCheck
session.pause / session.resume
session.takeControl / session.returnControl
session.focusWindow
task.start            { taskId, taskType, sessionId, input, adapterPack, executionMode, deadline }
task.cancel           { taskId, reason }
worker.health

# worker -> core (events/results)
session.changed       { sessionId, controlMode, status, currentUrl }
task.progress         { taskId, step, message }
task.checkpoint       { taskId, checkpoint }        # persisted by core before worker continues past it
task.needsHuman       { taskId, reason, instructions, screenshotRef }
task.result           { taskId, status, result, diagnostics? }
challenge.detected    { sessionId, kind, url }
ai.resolveTarget      { requestId, instruction, candidates[], context }   # request to core AI gateway
worker.heartbeat

# core -> worker
ai.resolveTarget.result { requestId, chosenRef | null, rationale, confidence, model }
```

Diagnostic primitives (`page.navigate`, `page.click`, `page.type`, `page.extract`, `page.screenshot`) exist for developer tooling only and are disabled in release builds unless a developer setting is on.

`task.result.status` is one of `succeeded | failed | unknown | unsupported_state | needs_human | cancelled`. Success is never implied by the absence of an exception.

### Checkpoint rule

Before the worker performs the irreversible part of a critical task (the final click/submit), it sends `task.checkpoint { phase: 'about_to_commit' }` and waits for core's acknowledgement. Core persists the checkpoint and sets the side-effect ledger entry to `executing` first. This guarantees that a crash after the click is always recognizable as "possibly sent" and handled as `unknown`.

## Browser tasks

Examples (the set grows with adapters):

```text
RenderPageForResearch         research profile; returns cleaned text + title
FindContactForm               forms adapter; returns form description
PrepareFormSubmission         fills fields, stops before submit, returns payload preview + screenshot
ExecuteFormSubmission         re-validates, submits (auto) or waits for user click (assisted), verifies
OpenLinkedInProfile           opens + verifies identity
CheckLinkedInConversation     returns whether new inbound messages exist since a timestamp
PrepareLinkedInMessage        opens composer, verifies recipient, fills text
ExecuteLinkedInMessage        sends (auto) or waits for user click (assisted), verifies
PrepareLinkedInConnect / ExecuteLinkedInConnect
```

Prepare/execute are split so that approval can happen between them and so that execute re-validates everything prepare established.

## Page-state recognition (allowlist)

Every adapter task declares the page states it expects at each step. A state from an adapter pack is a set of positive conditions, for example:

```json
{
  "id": "linkedin.profile.connectable",
  "url": ["https://www.linkedin.com/in/*"],
  "requires": [
    { "role": "heading", "level": 1 },
    { "role": "button", "nameAny": ["Connect", "Установить контакт"] }
  ],
  "forbids": [
    { "textAny": ["security verification", "unusual activity"] }
  ]
}
```

Rules:

- the worker acts only after the current page matches one of the expected states for the current step;
- if no expected state matches within the timeout, the task returns `unsupported_state` (with diagnostics); the workflow then tries bounded semantic observation where the step allows it, otherwise requests human help;
- challenge detection (`19-ERROR-RECOVERY.md`) runs in addition and takes priority, but safety does not depend on recognizing every challenge.

## Target resolution priority

1. adapter-pack locator (role/name/label/test-id, with locale variants);
2. generic semantic Playwright locators (role/name/label) derived from the task;
3. text locator when unambiguous;
4. semantic resolution: the worker enumerates candidates from a scoped accessibility snapshot (`locator.ariaSnapshot()` / role queries), assigns refs, and asks core's AI gateway to choose one ref or none (ADR 013);
5. human intervention.

Constraints:

- no brittle CSS/XPath chains derived from DOM position;
- semantic resolution is bounded (default max 2 attempts per step);
- in `auto` mode the final target of a critical action must be resolved by steps 1–3; if it cannot be, the task returns `needs_human` (the user can then complete it in `assisted` fashion).

## Execution modes in the worker

- `auto` — worker performs the final action after the checkpoint acknowledgement.
- `assisted` — worker prepares, highlights the final control via the overlay, focuses the window, notifies the user, and waits (bounded) for the user's click. It observes the page for the expected post-action state. On timeout or ambiguous outcome it returns `needs_human` and core asks the user to confirm the outcome.
- `manual` — worker opens the target and shows the prepared content in the overlay (copy button); the user does everything; core asks for outcome confirmation.

## Browser action lifecycle (within a task)

```text
PLANNED
  |
  v
VALIDATING (state recognized? target verified? control mode = automation?)
  |
  +--> UNSUPPORTED_STATE
  +--> NEEDS_HUMAN
  |
  v
AWAITING_COMMIT_ACK   (critical actions only)
  |
  v
EXECUTING  (or WAITING_FOR_USER_CLICK in assisted mode)
  |
  v
VERIFYING
  |
  +--> FAILED
  +--> UNKNOWN
  |
  v
COMPLETED
```

For critical actions, `UNKNOWN` is never converted to `COMPLETED` by the worker.

## Verification examples

### Form submit

- success message / confirmation page matching the adapter's success state;
- navigation to a confirmation URL;
- form replaced or disabled;
- known network response where safe.

If none are reliable, status is `unknown`.

### LinkedIn message send

- the sent message (matching content prefix) appears as the latest outbound message in the thread;
- composer cleared and no error toast.

## Human control

- `session.takeControl` sets control mode `human`: the worker finishes or aborts the current atomic Playwright call, rejects all further automation for that session, and keeps heartbeating.
- `session.pause` sets `paused` (automation stops at the next safe point; the user is not necessarily interacting).
- `session.returnControl` triggers revalidation (`11-HUMAN-TAKEOVER.md`) before control mode returns to `automation`.

## Profile ownership

Only one worker session may own a profile directory. The worker holds the lock implicitly (Chrome's own profile lock) and core tracks the session with heartbeats. If Chrome reports the profile is in use (e.g. a stray process), the profile is marked `unhealthy` and the user is asked to close it.

If the worker crashes:

- main kills orphaned Chrome processes launched by it;
- core marks the session `interrupted` and running tasks `interrupted`;
- workflows transition to recoverable states;
- the profile is re-opened and the page re-validated before any next action.

## Security challenges

Detect common signs of CAPTCHA, 2FA, reauthentication, suspicious-login challenge, account confirmation — via adapter-pack `challenge` states, generic markers (known CAPTCHA iframes, OTP inputs), and login-page recognition.

On detection:

```text
session -> PAUSED
workflow -> WAITING_FOR_HUMAN
intervention -> OPEN
```

## Diagnostics

On task failure capture, where safe:

- URL and page title;
- screenshot;
- redacted accessibility snapshot (preferred over HTML);
- expected states and which conditions failed;
- target description;
- worker, Chrome and adapter-pack versions;
- workflow state;
- error stack in local developer logs.

Never capture or persist password-field values.

## Testability

The worker must run against fixture sites served locally (`fixtures/sites`) using Playwright Chromium. CI tests never depend on live third-party sites. The worker can also run in plain Node (outside Electron) with a stub core for tests.
