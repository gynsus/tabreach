# ADR 027 — Research pages render without a window, behind a request guard

**Status:** Accepted (2026-09-29, Phase 5d)

## Context

Static fetching (docs/16) reads nothing from sites drawn by JavaScript. docs/16 plans `RenderPageForResearch` in the research profile. Every other browser session is a visible Chrome window: the person can see and take over anything that acts on a site in their name (docs/11). Research acts on nothing: it reads public pages of a company's own site and signs in nowhere. A real browser, however, runs the page's scripts, which can request any address — including the user's router, NAS or local development servers — and navigate elsewhere.

## Decision

- Research pages are rendered in the research profile (`purpose: research`, created on first use, never a channel identity), in headless Chrome (`headless: true` on `profile.open`), one page at a time, under automation, without the overlay. The window closes after a minute without work. If the person has the research profile open themselves, nothing is rendered.
- A page is rendered only after the static fetch of the same URL passed robots.txt, the same-site rule and the public-address check, and only when that fetch yielded less than 200 characters of readable text.
- Every request of the research context goes through a guard (`context.route`) and is **made by the worker itself** (`guardedFetch`, Node HTTP with a pinned lookup) and handed to Chrome with `route.fulfill`: the connection goes to the address that was checked (no DNS rebinding), redirects are followed by the worker hop by hop (Chrome does not ask the route again for a redirect it is given), and each hop is checked. The top-level page may not leave the company's site; no request — document, script, frame, XHR, redirect hop — may reach an IP literal or a host name that resolves to a non-public address (the same rules as the static fetcher, in `@tabreach/protocol`, with IPv4-in-IPv6 forms unwrapped); no cookies are sent or kept; non-HTTP schemes are refused; images, media and fonts are not loaded; WebSockets are closed; other pages are closed; service workers and downloads are blocked; WebRTC may not use non-proxied UDP (audit 5.5).
- A challenge on the page is recognized and the page is skipped: never solved, never handed to the person (research can do without the page).
- Headless Chrome identifies itself as such (`HeadlessChrome` in its user agent); nothing about it is disguised (ADR 009).

## Alternatives

- A visible window for research: a window popping up and closing for each JavaScript-only page, with nothing for the person to do in it.
- Static fetching only: JavaScript-only sites yield no evidence, and AI drafting for them has no facts.
- A separate throwaway Chromium: a second browser to ship; the research profile already exists for this.

## Consequences

- Research of JavaScript-only sites works and stays bounded to the company's own public pages.
- Requests are slower than Chrome's own networking (no connection reuse, bodies buffered up to 10 MB); acceptable for a few pages per company.
- The profiles screen can show the research profile as open while a page renders.

## Migration impact

None: no schema change. `profile.open` gains `headless` (default false).
