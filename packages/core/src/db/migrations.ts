export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Ordered schema migrations. Never edit an applied migration: the runner stores a checksum
 * and refuses to start when an applied migration's SQL has changed (docs/05-DATABASE-SCHEMA.md).
 *
 * Migrations are plain SQL kept in TypeScript so they ship inside the app bundle.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'settings',
    sql: `
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL CHECK (json_valid(value)),
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: 'secrets',
    sql: `
      -- Ciphertext produced by Electron safeStorage in main; never plaintext (docs/18).
      CREATE TABLE secrets (
        id         TEXT PRIMARY KEY,
        purpose    TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX secrets_purpose ON secrets (purpose);
    `,
  },
];
