# ADR 017 — Data-driven adapter packs

**Status:** Accepted (2026-09-28)

## Context

LinkedIn (and to a lesser extent generic forms) change their UI often. In a distributed desktop app, locators hard-coded in adapter code mean every user is broken until a new app release is built, signed, notarized and installed. Locale also matters: LinkedIn's UI language changes accessible names.

## Decision

Browser adapters are state machines in code that consume **adapter packs** — versioned, schema-validated data:

- page states (positive conditions: URL patterns, required/forbidden roles/names/text);
- locators with locale variants;
- verification rules (post-action states);
- challenge/login state definitions;
- default limits.

Packs contain no executable code. Every action event records the pack ID and version.

MVP: packs are bundled with the app.

Post-MVP: packs may be delivered independently as Ed25519-signed files verified against a public key embedded in the app, falling back to the bundled version on verification failure.

## Consequences

- UI changes can be fixed by editing data and fixtures, and later shipped without an app release.
- The `unsupported_state` rate per pack version is a direct signal of site changes.
- Pack schema design is an upfront cost; keep it minimal and extend when adapters need it.

## Implementation (Phase 5b, 2026-09-29)

- States have a `kind`: `page`, `logged_in`, `login` or `challenge`; challenges are matched first, on any site.
- Conditions: role (with name or locale variants, level), visible text, and `frameUrlAny` (iframe URL globs — how CAPTCHA widgets appear). All conditions of `requires` must hold, none of `forbids`.
- URLs are https only; `http://127.0.0.1` is allowed for fixture packs in tests.
- Bundled packs: `generic` 1.0.0 (challenges) and `linkedin` 0.1.0 (sign-in states only; the adapter's action states come with Phase 7). The matcher (`matchState`) is pure and tested without a browser; the worker implements its page probe with Playwright.


## Implementation (Phase 5c-2, 2026-09-29)

- Packs gain `actions[]`: a critical action as data — `from` states, `fill` (a control by role and accessible names, with UI-language variants, and the task parameter that fills it), one `commit` control, `success` and `rejected` states. Every state an action names must exist in the same pack. Controls are found by role and exact accessible name and must be unique and visible; otherwise the task is `unsupported_state` and nothing is pressed.
- The worker's `commit` task executes an action with the `about_to_commit` checkpoint (docs/07). Web-form and LinkedIn packs will define their actions in Phases 6 and 7.

## Implementation (Phase 7a, 2026-09-29)

- Actions gain `steps` (non-critical clicks, each into an expected state) and `identity` (the target is checked before any click and at the checkpoint); packs gain `identity` (where a profile page names the person, and the profile path), `readers` (a list control whose items are messages; `outgoingAny` phrases mark ours; only directions are read) and `limits` (product throttles per action class and minimum spacing). A pack's own `login` states make a task report `task.loginRequired`.

## Implementation (Phase 7, checked against real LinkedIn, 2026-10-09)

A hand check on real LinkedIn pages (pack 0.2.0 was built on fixtures only) changed the format and the `linkedin` pack, now 0.5.0:

- Role conditions and controls may name a landmark (`within`, e.g. `main` or `dialog`); a complementary landmark (`aside`) nested in it is left out — LinkedIn's sidebar of other people, with their Connect and Message, is an `aside` inside `main`; a floating chat window has its own composer. A control may match names that contain one of `nameAny` (`nameContains`) for names that carry the person's name ("Invite Irina Kuznetsova to connect"); it must still be the only visible match. A control may omit `nameAny`: it is then the only visible element with its role (the `main` a reader reads).
- A step either `click`s a control or `follow`s a link: the link's address is opened in the same tab, same origin only. LinkedIn's "Message" opens a floating window, a new page or nothing depending on what the site remembers; its address (`/messaging/compose/...`) always leads to the conversation's own page. A click step is pressed once; a click that changes nothing is `unsupported_state`, not repeated.
- The identity is checked again at the checkpoint while the page is a profile; a page reached from a verified profile (the conversation) is held to its exact address instead.
- A confirmation by a reader requires our typed text in the last message, not a higher count of ours (older messages load into an open thread).
- A reader's message list is the list with the most items carrying a sender's profile link (a list of conversations has none). No such list means no conversation yet — unless a list names the person, which is a conversation the reader cannot read: `null`, and nothing is written (fails closed).
- The pack's identity rule: the first level-2 heading inside `main`, plus the profile path. Only frames a person can see count for challenge conditions (an invisible reCAPTCHA widget is no challenge).
