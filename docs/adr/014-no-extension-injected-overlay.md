# ADR 014 — No Chrome extension; runtime-injected overlay

**Status:** Accepted (2026-09-28; Chrome fact confirmed in review round 2)

## Context

The original design had an MV3 extension for the overlay, pause/takeover controls, highlighting, page metadata and recorder assistance, with its own authenticated transport to the runtime.

Issues:

- starting with **Chrome 137, official Google Chrome branded builds do not support `--load-extension`** for unpacked extensions (Chromium and Chrome for Testing are not affected). Loading an extension would force Chrome for Testing / Chromium — a poor browser for real logins — or Chrome Web Store distribution;
- the extension introduced a second transport, an ephemeral-token scheme and a privileged trust boundary;
- all listed capabilities are available from Playwright directly.

## Decision

No extension in the MVP. The worker injects the overlay with `addInitScript` into a closed shadow root, drives it with `page.evaluate`, and receives input through one `exposeBinding`.

Because page scripts can call the binding, the binding accepts only `pause_requested`. Resume, return control and approvals exist only in the desktop app.

## Alternatives

- Extension via Chrome Web Store: distribution/review overhead, update lag, still a privileged component.
- Extension with Chrome for Testing: poor login experience and no auto-updates for users' real sessions.

## Consequences

- Simpler architecture, one less phase, one less trust boundary.
- The overlay is visible to page scripts (accepted; the product does not hide automation — ADR 009).
- Recorder features that relied on the extension are deferred (see `10-BROWSER-RECORDER.md`).
