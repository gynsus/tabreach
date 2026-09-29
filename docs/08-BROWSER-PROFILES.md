# 08 — Browser Profiles

## Goal

A browser profile is a durable, isolated browser identity owned by the application.

It preserves legitimate session state such as cookies and local storage while avoiding the fragility and security problems of automating the user's everyday Chrome profile.

## Implementation status (Phase 5a, 2026-09-29)

- Tables `browser_profiles` and `browser_sessions` (migration 15). Profiles are created as `general` or `research` in the app (Browser profiles screen); `channel_identity` comes with channel accounts (Phase 7). The directory is `<app data>/profiles/<id>`; ids are UUIDs, so a directory can never be outside that folder.
- Opening from the app starts the user's Google Chrome visibly (`launchPersistentContext`, `viewport: null`) with control mode `human`: nothing automated may act in it. Closing the last window ends the session (Chrome on macOS would otherwise keep running without windows).
- The worker keeps its running profiles across core restarts and reports them every 10 s (`worker.heartbeat`); core ends any session the worker no longer has (`interrupted`) and every session when the worker goes away. Main ends Chrome processes of our profiles folder left behind by a crashed worker, on worker exit, app start and quit.
- Health check: folder writable, not locked by another Chrome (`SingletonLock`), busy while open. Login state (`needs_login`) needs adapter-pack states (Phase 5b).
- Deleting requires the profile closed and its exact name typed; the worker removes the directory; only the audit record (ids) remains.

## Browser

Profiles run in the user's installed Google Chrome (`channel: 'chrome'`). The app does not download or bundle a browser in the MVP. The setup wizard and health checks detect Chrome and report its version; if Chrome is missing, browser features are disabled with instructions to install it.

Rationale: signing in to real sites (LinkedIn, Google) works best in branded, auto-updating Chrome. Chrome for Testing / Playwright Chromium are used only for automated tests.

## Profile directory

```text
~/Library/Application Support/TabReach/profiles/{profile-id}/
```

The path is derived from the profile ID; do not store absolute paths in domain entities.

## Profile purposes

- `channel_identity` — bound to one channel account (e.g. one LinkedIn identity). Used only for that channel's tasks.
- `research` — used for browser-rendered research. Never logged in to channel identities. Created automatically on first use.
- `general` — for user-defined manual use and web-form outreach.

Research must not run in a channel identity profile: browsing many company sites from the LinkedIn profile mixes identities and pollutes the session.

## Profile fields

Required:

- `id`;
- display name;
- purpose;
- linked channel account (optional);
- status;
- locale;
- timezone;
- browser channel (`chrome`; `chromium` in tests);
- timestamps;
- health details.

Optional future:

- proxy config for legitimate enterprise/network use;
- policy set.

Do not introduce fingerprint spoofing.

## Profile lifecycle

```text
NEW
 |
 v
READY
 |
 +--> OPEN
 |      |
 |      +--> NEEDS_LOGIN
 |      +--> UNHEALTHY
 |      +--> READY
 |
 +--> ARCHIVED
```

Deletion is separate from archive.

## First login

The user opens a profile from the app and authenticates directly on the website in the visible Chrome window.

The application never requests or stores site passwords to automate login.

OAuth, passkeys, 2FA and security challenges remain in the visible browser.

## Profile ownership

A profile can have one automation controller at a time.

Manual human control is not a second controller; it is a control mode that suspends automation.

The user must not open the same profile directory in their own Chrome; the app does not expose the directory path in the UI except in developer diagnostics.

## Health check

A health check may inspect:

- Chrome installed and version;
- browser process start success;
- profile directory readability/writability and Chrome's profile lock;
- channel-specific login status where safely detectable (adapter-pack `logged_in` / `login_page` states);
- whether a challenge page is active.

Health status:

```text
healthy
needs_login
needs_human
busy
unhealthy
unknown
```

## Backups

The app never syncs or backs up profile directories automatically.

Profile directories contain authenticated session data and are credential-equivalent.

No database backup includes profile directories. Local recovery backups contain the `secrets` table only as `safeStorage` ciphertext; portable exports exclude it entirely (`03-SYSTEM-ARCHITECTURE.md`).

## Profile deletion

1. ensure the profile is not open;
2. show that authenticated browser state will be destroyed;
3. require typing the profile name;
4. delete the local directory;
5. retain only non-secret audit metadata.

## Browser updates

Chrome auto-updates independently. Do not couple workflow correctness to an exact browser version.

Health diagnostics and action events record the Chrome version so regressions after a Chrome update are visible.
