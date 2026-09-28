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
  {
    version: 3,
    name: 'prospects',
    sql: `
      CREATE TABLE companies (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        -- Unicode-aware lowercase keys computed in TypeScript: SQLite's lower()/LIKE fold ASCII only.
        name_key          TEXT NOT NULL,
        search_key        TEXT NOT NULL,
        domain_normalized TEXT,
        website_url       TEXT,
        country           TEXT,
        city              TEXT,
        timezone          TEXT,
        status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        custom_fields     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(custom_fields)),
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      ) STRICT;
      -- One company per domain: domain is the dedupe key (FR-PROS-005).
      CREATE UNIQUE INDEX companies_domain ON companies (domain_normalized) WHERE domain_normalized IS NOT NULL;
      CREATE INDEX companies_name_key ON companies (name_key);

      CREATE TABLE contacts (
        id               TEXT PRIMARY KEY,
        company_id       TEXT REFERENCES companies (id) ON DELETE SET NULL,
        first_name       TEXT,
        last_name        TEXT,
        full_name        TEXT,
        job_title        TEXT,
        email            TEXT,
        email_normalized TEXT,
        name_key         TEXT,
        search_key       TEXT NOT NULL,
        email_status     TEXT NOT NULL DEFAULT 'unknown'
                         CHECK (email_status IN ('unknown', 'valid', 'bounced', 'invalid')),
        timezone         TEXT,
        status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        custom_fields    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(custom_fields)),
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      ) STRICT;
      -- One contact per normalized email (FR-PROS-005).
      CREATE UNIQUE INDEX contacts_email ON contacts (email_normalized) WHERE email_normalized IS NOT NULL;
      CREATE INDEX contacts_company ON contacts (company_id);
      CREATE INDEX contacts_name_key ON contacts (company_id, name_key);

      CREATE TABLE contact_profile_urls (
        id             TEXT PRIMARY KEY,
        contact_id     TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
        channel        TEXT NOT NULL CHECK (channel IN ('linkedin', 'other')),
        url_original   TEXT NOT NULL,
        url_normalized TEXT NOT NULL
      ) STRICT;
      -- A profile URL identifies exactly one contact.
      CREATE UNIQUE INDEX contact_profile_urls_unique ON contact_profile_urls (channel, url_normalized);
      CREATE INDEX contact_profile_urls_contact ON contact_profile_urls (contact_id);

      CREATE TABLE tags (
        id       TEXT PRIMARY KEY,
        name     TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE company_tags (
        company_id TEXT NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
        tag_id     TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
        PRIMARY KEY (company_id, tag_id)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE contact_tags (
        contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
        tag_id     TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
        PRIMARY KEY (contact_id, tag_id)
      ) STRICT, WITHOUT ROWID;
    `,
  },
  {
    version: 4,
    name: 'suppressions',
    sql: `
      CREATE TABLE suppressions (
        id               TEXT PRIMARY KEY,
        kind             TEXT NOT NULL CHECK (kind IN ('email', 'domain', 'company', 'profile_url')),
        value_original   TEXT NOT NULL,
        value_normalized TEXT NOT NULL,
        reason           TEXT NOT NULL CHECK (reason IN ('opt_out', 'bounce', 'manual', 'imported')),
        source_ref       TEXT CHECK (source_ref IS NULL OR json_valid(source_ref)),
        created_at       TEXT NOT NULL,
        UNIQUE (kind, value_normalized)
      ) STRICT;
    `,
  },
  {
    version: 5,
    name: 'action_events',
    sql: `
      CREATE TABLE action_events (
        id                   TEXT PRIMARY KEY,
        correlation_id       TEXT NOT NULL,
        causation_id         TEXT,
        actor_type           TEXT NOT NULL
                             CHECK (actor_type IN ('user', 'system', 'ai', 'browser_worker', 'channel_adapter')),
        action_type          TEXT NOT NULL,
        object_type          TEXT,
        object_id            TEXT,
        status               TEXT NOT NULL,
        adapter_pack_version TEXT,
        payload_redacted     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_redacted)),
        created_at           TEXT NOT NULL
      ) STRICT;
      CREATE INDEX action_events_correlation ON action_events (correlation_id, created_at);
      CREATE INDEX action_events_object ON action_events (object_type, object_id, created_at);
      CREATE INDEX action_events_created ON action_events (created_at);

      -- The audit trail is append-only; the database enforces it, not discipline (FR-AUD).
      CREATE TRIGGER action_events_no_update BEFORE UPDATE ON action_events
      BEGIN SELECT RAISE(ABORT, 'action_events is append-only'); END;
      CREATE TRIGGER action_events_no_delete BEFORE DELETE ON action_events
      BEGIN SELECT RAISE(ABORT, 'action_events is append-only'); END;
    `,
  },
];
