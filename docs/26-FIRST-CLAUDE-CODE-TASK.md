# 26 — First Claude Code Task

Use this file as the first implementation instruction after Claude Code has read all required architecture documents.

## Objective

Implement **Phase 0 — Repository, process skeleton and packaging spike** from `22-IMPLEMENTATION-PLAN.md`.

Do not implement business features yet.

## Required deliverables

1. Monorepo with pnpm workspaces:
   - `apps/desktop` (Electron main, preload, React renderer via electron-vite)
   - `packages/protocol`
   - `packages/core`
   - `packages/browser-worker`
   - `packages/adapter-packs` (schema only, no packs yet)
   - `fixtures/sites` (one static page for the Chrome launch check)

2. TypeScript strict config shared across packages; ESLint (incl. import-boundary rules from `25-DEVELOPMENT-CONVENTIONS.md`), Prettier, `.editorconfig`, `.gitignore`.

3. Process skeleton:
   - main spawns core as `utilityProcess` and the worker through a thin host adapter (initially `utilityProcess`), restarts them with bounded backoff;
   - main creates MessagePorts: renderer ↔ core, core ↔ worker;
   - protocol envelope + Zod validation in `packages/protocol`;
   - `health` query flows renderer → core → worker and back.

4. Core:
   - opens SQLite at the Application Support path (configurable for dev/tests) with the documented pragmas;
   - drizzle-kit migrations with an automatic pre-migration local recovery backup via the SQLite backup API (never a plain file copy);
   - one trivial table (`settings`) and its migration;
   - reports DB health.

5. Secret broker in main using `safeStorage`; core can store and read back a test secret through main; plaintext never logged.

6. Worker:
   - detects installed Google Chrome and its version;
   - launches a throwaway profile directory via Playwright `launchPersistentContext({ channel: 'chrome', headless: false })`, opens the fixture page, closes it (triggered from the status screen);
   - reports health.

7. Renderer status screen showing core, worker, database and Chrome health and versions.

8. pino logging per process to the Logs directory with redaction config and a redaction unit test.

9. Tests and CI:
   - Vitest wired for all packages with at least the real tests implied above (protocol validation, migrations on a temp DB, redaction, secret round-trip where testable);
   - Playwright Test wired with one Electron smoke test (app starts, status screen shows healthy core/DB);
   - GitHub Actions workflow on a macOS runner: install, typecheck, lint, test.

10. Spikes, each with a short written result appended to the relevant ADR:
    - `pnpm package` builds an unsigned `.app` with electron-builder that starts and runs migrations (ADR 011/012); list what signing/notarization will require;
    - `better-sqlite3` works under Electron and under plain Node in tests, or `node:sqlite` is adopted instead (ADR 011);
    - **do first**: packaged browser-worker validation (ADR 012) — in the packaged `.app` on Apple Silicon macOS, the worker launches installed Chrome with a persistent profile, runs `page.goto('https://example.com')`, waits for load, reads the title, closes, and repeats after an app restart. If the `utilityProcess` host fails, try the fallback hosts from ADR 012 in order and record the choice (including the `RunAsNode` fuse consequence).

11. `docs/DEVELOPMENT.md` with exact setup/run/test/package commands based on the implemented repository.

12. Run all checks and report actual commands and results in the final response.

## Constraints

- No business tables beyond `settings`.
- No email, AI provider, research, campaigns or LinkedIn code.
- No Docker, no HTTP servers, no persistent listening ports.
- Never commit real secrets.

## Acceptance

Phase 0 is accepted when a fresh clone can follow `docs/DEVELOPMENT.md`, run `pnpm dev`, see all components healthy on the status screen, launch Chrome from it and load a real Internet page, and build a `.app` that does the same — with the worker host choice recorded in ADR 012.
