# ADR 012 — Electron process topology and in-app IPC

**Status:** Accepted (2026-09-28). Browser-worker host validated in Phase 0: `utilityProcess`. Supersedes ADR 010.

## Context

Within a single Electron app we still want:

- the database owner isolated from Chrome/Playwright crashes;
- the UI isolated from Node privileges;
- domain code testable in plain Node without Electron;
- no persistent network listeners (hostile web pages can reach localhost).

Known risk (review round 2): electron/electron#48145 — in a packaged Electron 37 app with Playwright 1.54 on Windows, Chrome launched by Playwright from a `utilityProcess` had no Internet connectivity; the issue was closed as "not planned". It is not known whether this affects macOS or current Electron versions, so the worker host cannot yet be an invariant.

## Decision

Four processes of our own:

1. **main** — supervisor, windows, tray, power events, `safeStorage` secret broker, OAuth loopback flow, IPC broker. No domain logic, no DB, no Playwright.
2. **renderer** — React UI, sandboxed, context-isolated, talks through a minimal preload bridge.
3. **core** (`utilityProcess`) — domain, SQLite, jobs, workflows, policy, approvals, email, research, AI gateway. No Electron imports.
4. **browser worker** (`utilityProcess`) — Playwright, profiles, sessions, browser adapters, overlay. No DB, no provider keys. Talks to its host only through a thin **host adapter** (message channel + lifecycle), so the host type can be swapped without touching worker logic.

IPC: `MessageChannelMain` ports (or the chosen host's IPC channel) brokered by main; envelope + Zod validation in `packages/protocol`; app protocol (renderer↔core) and browser protocol (core↔worker).

Main restarts crashed core/worker with bounded backoff and kills orphaned Chrome processes.

### Browser-worker host: validation and fallback order

Phase 0 runs this check **before** other work is built on the worker: in the packaged `.app` on Apple Silicon macOS, the worker launches the installed Chrome with a persistent profile, runs `page.goto('https://example.com')`, waits for load, reads the title, closes, and repeats after an app restart.

Hosts, in order of preference:

1. `utilityProcess` — preferred (Electron's bundled Node, no extra fuse, MessagePort-native).
2. `child_process.fork` of the app's Electron binary with `ELECTRON_RUN_AS_NODE=1` — requires the `RunAsNode` fuse to stay **enabled**, which weakens hardening (any local process could run the app binary as Node). Only acceptable if (1) fails; the security doc's fuse list is then amended here explicitly.
3. A separately bundled, signed Node binary spawned as a child process — keeps `RunAsNode` disabled at the cost of bundle size (~40–50 MB) and one more binary to sign/notarize.

The first host that passes is recorded below; `CLAUDE.md`, `03-SYSTEM-ARCHITECTURE.md` and `18-SECURITY-PRIVACY-COMPLIANCE.md` are then updated to name it.

## Alternatives

- Everything in the main process: simplest, but Playwright/Chrome problems or long synchronous SQLite calls would freeze the UI.
- Core in main, worker separate: puts domain logic into Electron-specific code and blocks the UI event loop during DB work.
- Local HTTP/WebSocket between processes: needs ports, tokens, CORS/CSRF; no benefit inside one app.

## Consequences

- Crash isolation and clean testability.
- No persistent network attack surface.
- Protocol schemas are shared TypeScript.
- Worker host is `utilityProcess`; fallbacks (2) and (3) are not needed, so the `RunAsNode` fuse stays disabled.

## Phase 0 validation result

Run 2026-09-28 on Apple Silicon, macOS 26.3, Electron 44.4.5, Playwright 1.63.0, Google Chrome 154.0.8037.57.

1. Throwaway spike app (asar, ad-hoc signed, no fuses): both hosts, `utilityProcess` and `fork` + `ELECTRON_RUN_AS_NODE`, launched the installed Chrome with a persistent profile, loaded `https://example.com` (HTTP 200, title "Example Domain") and closed. Repeated after an app restart and when launched through LaunchServices (`open`). First launch took about 6.6 s, later ones about 0.9 s. electron/electron#48145 did not reproduce on macOS.
2. The real TabReach `.app`, with fuses applied (`RunAsNode` off, Node CLI inspect off, `NODE_OPTIONS` off, ASAR integrity and only-load-from-ASAR on), passed `--self-check=https://example.com` twice from the terminal and once through LaunchServices: core, database, safeStorage round trip, worker and Chrome launch all OK.

**Chosen host: `utilityProcess`.** `CLAUDE.md`, `03-SYSTEM-ARCHITECTURE.md` and `18-SECURITY-PRIVACY-COMPLIANCE.md` are updated accordingly. The worker keeps the thin host adapter so the choice stays reversible if a future Electron or Chrome release regresses; CI runs the packaged self-check on every push to catch that.
