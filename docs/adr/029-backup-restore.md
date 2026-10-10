# ADR 029 — Restoring a backup restarts core onto it; the outside world does not roll back

**Status:** Accepted (2026-10-10, Phase 8b)

## Context

docs/03 defines two kinds of copies: a local recovery backup (full database, secrets as `safeStorage` ciphertext, `data/backups/`) and a portable export (no secrets). FR-APP-005 asks for creating both and for restoring a backup. Core is the only process that opens `app.db` (ADR 011) and keeps it open while it runs, so a restore cannot swap the file underneath it. A backup is also a step back in time: anything sent after it was made — an email, a LinkedIn message, a form — would look unsent in the restored database, and the engine would send it again. That breaks the core guarantee: never an automatic duplicate (CLAUDE.md §3.12). Equally, someone who opted out after the backup would reappear as contactable.

## Decision

- **Backups.** Made with the SQLite backup API into `data/backups/` (folder 0700, files 0600): `manual-…` on request, `pre-migration-…` before every migration (as before), `pre-restore-…` before every restore. The ten newest automatic ones are kept; manual ones stay until the person deletes them. Browser profiles and screenshots are files outside the database and are in no backup.
- **Restore in two steps.** `backup.restore` checks the chosen file now (`PRAGMA quick_check`, a `schema_migrations` table whose every migration this app knows unedited, a `secrets` table — a portable export has none), pauses everything, writes `data/restore-pending.json` and asks for a restart: core closes the database and exits with code 75, which the supervisor in main treats as a requested restart (immediate, not counted as a crash). On start, before the database is opened, core applies the pending restore:
  1. the marker is removed first, so a failing restore is attempted once, never in a loop of failing starts;
  2. the current database is backed up (`pre-restore-…`) — the restore can itself be undone;
  3. the backup is copied to `app.db.restoring` and migrated to this app's schema;
  4. **carried forward from the current database:** the whole send ledger (`side_effects`, and the test channel's deliveries) and every do-not-contact entry (`suppressions`). An enrollment rolled back to a step already sent reserves the same logical intent (ADR 018), finds it `completed` and moves on without sending; frequency caps and per-account limits count every real send;
  5. the app control is set to paused, the outcome stored (`backup.lastRestore`) and audited, the copy switched to a rollback journal, and atomically renamed over `app.db` (stale `-wal`/`-shm` removed first, so no old log is replayed onto it).
  On any failure the current database is left untouched and the failure is stored, shown in Settings → Data.
- **The app starts paused** after a restore: the person sees the restored campaigns before anything goes out, and presses Resume.
- **Portable export.** `VACUUM INTO` a temporary file in the data folder; there, with `secure_delete` on, account references to secrets are cleared and the `secrets` and `command_log` tables dropped, then the file is vacuumed again so no freed page keeps ciphertext. Core asks main for the native save dialog (`file.chooseSavePath` on the host channel) and copies the file to the chosen path (0600). It is a plain SQLite file and is not restorable.

## Alternatives

- **Restore everything as of the backup, ledger included:** simple, but every send since the backup becomes a candidate for a second send — a duplicate the person never asked for.
- **Swap the file while core runs (close, replace, reopen in place):** every service holds prepared statements and state over the open connection; a process restart is the one clean boundary, and the same path recovers from crashes already.
- **Restore by main, outside core:** main would have to open the database, which ADR 011 reserves to core.
- **Restore from any file the person picks:** a file from another Mac carries ciphertext this Keychain cannot decrypt; the list offers the backups of this installation (a file can still be put into `data/backups/` by hand).

## Consequences

- A restore loses changes made after the backup except the ledger and the do-not-contact list; replies received since are fetched again by the inbox (its cursor rolls back too).
- Secrets come from the backup: an OAuth token rotated or an AI key changed since may need to be entered again.
- Browser profiles are not rolled back. A profile created after the backup stays on disk unused; one deleted since is gone and must be created and signed in again.

## Migration impact

No schema change. `migrate()` gains `skipBackup` for the copy being restored.
