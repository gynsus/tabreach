# 12 — In-Page Overlay (replaces the Browser Extension)

## Decision summary

The MVP has **no Chrome extension**. The overlay and page instrumentation are injected by the browser worker through Playwright. See ADR 014.

Reasons:

- starting with Chrome 137, official Google Chrome branded builds do not support `--load-extension` for unpacked extensions; using an extension would force Chrome for Testing / Chromium (poor for real logins) or Web Store distribution;
- everything the extension was meant to do (overlay, highlighting, page metadata) is available from Playwright directly;
- removing it removes a transport, an authentication scheme, a distribution/signing problem and a whole trust boundary.

## Mechanism

- `browserContext.addInitScript()` installs the overlay bootstrap in every page of automation-owned contexts.
- The overlay renders inside a closed shadow root attached to a top-level host element, with isolated styles.
- Worker → overlay: the worker calls `page.evaluate()` with a small, fixed set of functions (`setContext`, `highlight`, `clearHighlight`, `setMode`, `showContent`).
- Overlay → worker: one binding exposed with `browserContext.exposeBinding('__tabreachOverlay', handler)`.

## Trust boundary

Script injected into the page runs in the page's main world. The page's own JavaScript can see the overlay and **can call the binding**. Therefore:

- the binding accepts exactly one message type: `pause_requested`. Everything else is ignored and logged;
- pausing is always safe (it can only reduce automation); an attacker page can at worst pause automation;
- resume, return control, approve, and any data-returning call are **not** available from the page;
- the overlay never receives secrets, full drafts of other prospects, or anything beyond the current task's display data;
- the overlay never imitates the host site's native controls.

## Capabilities

- compact overlay with current campaign, prospect and intended action;
- control-mode indicator (`automation`, `paused`, `human`);
- Pause button;
- target highlight (outline + label) for the element the worker resolved;
- assisted-mode instruction ("Review and click the highlighted Send button");
- manual-mode content panel with copy-to-clipboard;
- collapsible/dismissible.

## Implementation status (Phase 5c-1)

The overlay is installed only in windows opened under automation (`addInitScript` in the automation context; a window the person opens has none). It shows the mode, the current work's title and detail (sent by core with `session.setOverlay`, in the interface language) and the Pause button while automation runs. The overlay puts itself back if a page removes it. An unknown binding message is logged once per session. Page scripts can read what the overlay shows, so its context is a short label only — no prospect, draft or campaign data (audit 5.5). The one exception is `manual` mode (ADR 015): the prepared text, with a Copy button, is shown only on pages of the site it is meant for (`contentOrigin`, LinkedIn's own origin), where the person is about to paste it anyway; on any other page in the window it is left out, and titles carry no names. The binding `__tabreachOverlay` accepts only `pause_requested`; other messages are logged and ignored, and the page cannot resume. The mode is re-applied on each `domcontentloaded`. Highlighting and assisted/manual panels come with the first channel actions (Phase 6/7).

## Page metadata

Page metadata for tasks is collected by the worker via Playwright (URL, title, accessibility snapshot of relevant regions), not by the overlay. Do not send entire pages by default.

## Limitations accepted

- The overlay is visible to the page (the product does not hide automation — ADR 009).
- Pages with aggressive DOM rewriting may remove the host element; the worker re-injects on navigation and on detection of removal. The overlay is explanatory; correctness never depends on it.
