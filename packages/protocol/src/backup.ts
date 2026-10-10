import { z } from 'zod';

/**
 * Local recovery backups and the portable export (docs/03 "Two kinds of backup", FR-APP-005).
 * A backup is a full copy of the database in `data/backups/`, secrets as `safeStorage` ciphertext
 * only; it can be restored on this Mac user. The portable export has no secrets at all and cannot
 * be restored.
 */
export const backupKindSchema = z.enum(['manual', 'pre_migration', 'pre_restore']);
export type BackupKind = z.infer<typeof backupKindSchema>;

/** A plain file name inside `data/backups/`: never a path. */
export const backupNameSchema = z
  .string()
  .max(120)
  .regex(/^(manual|pre-migration|pre-restore)-[A-Za-z0-9-]+\.db$/);

export const backupSchema = z.object({
  name: backupNameSchema,
  kind: backupKindSchema,
  createdAt: z.iso.datetime(),
  bytes: z.number().int().nonnegative(),
  /** The schema version inside; null when the file cannot be read as a database. */
  schemaVersion: z.number().int().nonnegative().nullable(),
});
export type Backup = z.infer<typeof backupSchema>;

/** The last restore: applied when core restarted, or refused then (the database stayed as it was). */
export const lastRestoreSchema = z.object({
  name: backupNameSchema,
  at: z.iso.datetime(),
  ok: z.boolean(),
  /** The backup of the database as it was just before; null when the restore failed. */
  preRestore: backupNameSchema.nullable(),
});
export type LastRestore = z.infer<typeof lastRestoreSchema>;

export const backupListSchema = z.object({
  items: z.array(backupSchema),
  lastRestore: lastRestoreSchema.nullable(),
  /** The schema version of the running app: a backup newer than this cannot be restored. */
  schemaVersion: z.number().int().nonnegative(),
});

/** Restoring: checked now, applied by a core restart; the app then starts paused. */
export const backupRestoreResultSchema = z.object({ restarting: z.literal(true) });

export const portableExportResultSchema = z.discriminatedUnion('saved', [
  z.object({ saved: z.literal(false) }),
  z.object({ saved: z.literal(true), bytes: z.number().int().nonnegative() }),
]);
export type PortableExportResult = z.infer<typeof portableExportResultSchema>;
