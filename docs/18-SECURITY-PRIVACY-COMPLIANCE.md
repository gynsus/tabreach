# 18 — Security, Privacy and Compliance

## Security goals

Protect:

- authenticated browser sessions (profile directories);
- OAuth credentials and AI API keys;
- prospect data;
- message content;
- the application's own control surfaces (IPC, overlay binding).

## No persistent network listeners

The app exposes no persistent application HTTP/WebSocket listeners. All inter-process communication uses Electron `MessagePort`s, so hostile webpages cannot reach the app through `localhost`. This removes the need for local API tokens, CORS and CSRF protection.

The only listener is the OAuth loopback redirect:

- bound to `127.0.0.1` on an ephemeral port;
- opened only during an authorization the user started;
- accepts one request, validates `state`, uses PKCE;
- closes after the redirect or a short timeout.

Chrome is controlled over a pipe, not a remote-debugging port.

## Electron hardening

- renderer: `contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP, no remote content, `will-navigate` and `setWindowOpenHandler` deny by default;
- preload exposes a minimal typed bridge (`invoke` for app-channel requests only, `saveTextFile`); every message validated by core or main;
- the only renderer → main IPC is `tabreach:save-text-file`: main checks that the sender is the app's own page, validates the payload and writes only to the path the user chose in the native save dialog;
- core and browser worker in `utilityProcess` (no renderer privileges; ADR 012);
- Electron fuses in every packaged build: `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` disabled; cookie encryption, embedded ASAR integrity validation and `OnlyLoadAppFromAsar` enabled (ADR 012 confirmed no worker host needs `RunAsNode`). Because the inspector is disabled, packaged builds are verified with `--self-check`, not by attaching automation;
- hardened runtime + notarization for release.

## Secrets

- Storage: ciphertext from Electron `safeStorage` (Keychain-backed key on macOS) in the `secrets` table.
- Only main encrypts/decrypts. Core requests a secret for a specific purpose over its port and keeps plaintext in memory only as long as needed.
- The browser worker never receives provider keys or OAuth tokens.
- Plaintext secrets never appear in any backup, export or bundle. Local recovery backups contain `safeStorage` ciphertext (bound to this Mac user); portable exports and diagnostics bundles exclude the `secrets` table entirely.
- Development: `.env` may hold development-only keys, must be gitignored, and is ignored in release builds.

## Browser profile sensitivity

A browser profile contains active authenticated sessions. Treat its directory as credential-equivalent.

Do not:

- upload it anywhere;
- include it in backups or diagnostics;
- commit it;
- package it into test fixtures.

## In-page overlay

The overlay runs in the page's main world, so the page can call its binding. The binding accepts only `pause_requested` (safe direction). See `12-IN-PAGE-OVERLAY.md`.

## Adapter packs

- MVP: bundled in the signed app.
- Post-MVP remote delivery: only Ed25519-signed packs verified against a public key embedded in the app; packs are data validated by schema, never executable code.

## Prompt injection

Website content and inbound emails are untrusted.

Models have no side-effecting tools; outputs are schema-validated data; semantic resolution picks among enumerated candidates only.

Never expose secrets to prompts.

## External platform rules

Browser adapters may interact with services that restrict or prohibit automated activity (LinkedIn's user agreement prohibits automated access).

The product must:

- keep each adapter independently configurable with a kill switch;
- show the platform risk in the UI when the adapter is enabled;
- default LinkedIn to `assisted` execution;
- avoid claims of undetectability or guaranteed account safety;
- avoid bot-evasion/stealth features;
- support manual execution and human approval.

## Outreach compliance primitives

The product operates across jurisdictions, so it provides primitives rather than legal conclusions:

- suppression/do-not-contact list;
- per-contact channel eligibility;
- opt-out detection from replies and optional `List-Unsubscribe` header;
- sender identity/signature configuration;
- stop future outreach after opt-out;
- audit of consent/source fields when supplied by user;
- configurable quiet hours and region notes.

Do not represent these features as legal advice.

## Data retention

Configurable retention categories:

- screenshots;
- browser diagnostics;
- AI raw responses;
- message bodies;
- research evidence;
- audit events (MVP: kept — the table is append-only at the database level; pruning needs an explicit, audited mechanism);
- logs.

Defaults minimize unnecessary sensitive data while preserving debugging/audit value. Retention is enforced by a periodic core job.

## Updates and dependencies

- lockfiles required; automated dependency scanning in CI;
- Electron security updates prioritized (Electron ships Chromium for the app UI);
- Chrome itself updates independently;
- no stealth automation dependencies.
