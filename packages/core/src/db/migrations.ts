import type { DatabaseSync } from 'node:sqlite';
import { searchKey } from '../prospects/normalize.js';

export interface Migration {
  version: number;
  name: string;
  /** Checksummed; never edit once released. */
  sql: string;
  /**
   * Optional data step run after `sql` in the same transaction, for work SQL cannot do (e.g.
   * Unicode-aware keys). Not checksummed: keep it small and never change its effect once released.
   */
  run?: (db: DatabaseSync) => void;
  /** Disable foreign keys around this migration (table rebuilds); integrity is checked before commit. */
  foreignKeysOff?: boolean;
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
  {
    version: 6,
    name: 'suppression_search_and_command_log',
    sql: `
      -- Unicode-aware search over the do-not-contact list (SQLite lower() folds ASCII only).
      ALTER TABLE suppressions ADD COLUMN search_key TEXT NOT NULL DEFAULT '';

      -- Results of creating commands by idempotency key: a retried command returns the first
      -- result instead of running again (ADR 020). Pruned after 7 days.
      CREATE TABLE command_log (
        idempotency_key TEXT PRIMARY KEY,
        command_type    TEXT NOT NULL,
        result          TEXT NOT NULL CHECK (json_valid(result)),
        created_at      TEXT NOT NULL
      ) STRICT;
      CREATE INDEX command_log_created ON command_log (created_at);
    `,
    run(db) {
      const rows = db.prepare('SELECT id, value_original, value_normalized FROM suppressions').all() as {
        id: string;
        value_original: string;
        value_normalized: string;
      }[];
      const update = db.prepare('UPDATE suppressions SET search_key = ? WHERE id = ?');
      for (const r of rows) update.run(searchKey([r.value_original, r.value_normalized]), r.id);
    },
  },
  {
    version: 7,
    name: 'jobs_and_side_effects',
    sql: `
      -- Durable job queue (ADR 011, ADR 021 section 2). Jobs own execution retries.
      CREATE TABLE jobs (
        id                  TEXT PRIMARY KEY,
        type                TEXT NOT NULL,
        payload             TEXT NOT NULL CHECK (json_valid(payload)),
        status              TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'dead')),
        run_at              TEXT NOT NULL,
        attempts            INTEGER NOT NULL DEFAULT 0,
        max_attempts        INTEGER NOT NULL,
        lease_owner         TEXT,
        lease_until         TEXT,
        last_error_class    TEXT,
        last_error_redacted TEXT,
        dedupe_key          TEXT UNIQUE,
        correlation_id      TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      ) STRICT;
      CREATE INDEX jobs_due ON jobs (status, run_at);

      -- Ledger of external side effects, one row per logical intent (ADR 018, ADR 021 section 3).
      CREATE TABLE side_effects (
        id                TEXT PRIMARY KEY,
        idempotency_key   TEXT NOT NULL UNIQUE,
        scope_id          TEXT NOT NULL,
        step_position     INTEGER NOT NULL,
        channel           TEXT NOT NULL,
        action_type       TEXT NOT NULL,
        target_normalized TEXT NOT NULL,
        workflow_run_id   TEXT,
        status            TEXT NOT NULL CHECK (status IN ('reserved', 'executing', 'completed', 'not_sent', 'unknown')),
        content_hash      TEXT,
        external_refs     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(external_refs)),
        reconciled_by     TEXT CHECK (reconciled_by IN ('provider_lookup', 'ui_verification', 'user_confirmation')),
        error_class       TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      ) STRICT;
      CREATE INDEX side_effects_target ON side_effects (channel, target_normalized, status, updated_at);
      CREATE INDEX side_effects_status ON side_effects (status);

      -- The test channel's "outside world": what it delivered, by idempotency key (ADR 021 section 7).
      CREATE TABLE test_channel_deliveries (
        id              TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        target          TEXT NOT NULL,
        subject         TEXT,
        body            TEXT NOT NULL,
        content_hash    TEXT NOT NULL,
        created_at      TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 8,
    name: 'campaigns_and_workflows',
    sql: `
      -- Campaigns (docs/17). draft_config is the mutable editing state; launching freezes a version.
      CREATE TABLE campaigns (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        status            TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'archived')),
        draft_config      TEXT NOT NULL CHECK (json_valid(draft_config)),
        active_version_id TEXT REFERENCES campaign_versions (id),
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        lock_version      INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE TABLE campaign_versions (
        id             TEXT PRIMARY KEY,
        campaign_id    TEXT NOT NULL REFERENCES campaigns (id),
        version_number INTEGER NOT NULL,
        -- Non-step settings only; steps live in sequence_steps.
        config         TEXT NOT NULL CHECK (json_valid(config)),
        created_at     TEXT NOT NULL,
        UNIQUE (campaign_id, version_number)
      ) STRICT;

      CREATE TABLE sequence_steps (
        id                  TEXT PRIMARY KEY,
        campaign_version_id TEXT NOT NULL REFERENCES campaign_versions (id),
        position            INTEGER NOT NULL CHECK (position >= 1),
        step_type           TEXT NOT NULL CHECK (step_type IN ('send_message', 'condition')),
        execution_mode      TEXT CHECK (execution_mode IN ('auto', 'assisted', 'manual')),
        delay_seconds       INTEGER NOT NULL CHECK (delay_seconds >= 0),
        config              TEXT NOT NULL CHECK (json_valid(config)),
        created_at          TEXT NOT NULL,
        UNIQUE (campaign_version_id, position)
      ) STRICT;

      -- The enrollment owns which step a prospect is on and the gap between steps (ADR 021 section 1).
      CREATE TABLE campaign_enrollments (
        id                    TEXT PRIMARY KEY,
        campaign_id           TEXT NOT NULL REFERENCES campaigns (id),
        campaign_version_id   TEXT NOT NULL REFERENCES campaign_versions (id),
        company_id            TEXT REFERENCES companies (id) ON DELETE SET NULL,
        contact_id            TEXT REFERENCES contacts (id),
        status                TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'stopped')),
        current_step_position INTEGER NOT NULL DEFAULT 1,
        next_action_at        TEXT,
        stop_reason           TEXT,
        last_reply_at         TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        lock_version          INTEGER NOT NULL DEFAULT 0,
        CHECK (company_id IS NOT NULL OR contact_id IS NOT NULL)
      ) STRICT;
      -- A contact is in a campaign at most once.
      CREATE UNIQUE INDEX campaign_enrollments_contact ON campaign_enrollments (campaign_id, contact_id)
        WHERE contact_id IS NOT NULL;
      CREATE INDEX campaign_enrollments_due ON campaign_enrollments (status, next_action_at);
      CREATE INDEX campaign_enrollments_contact_id ON campaign_enrollments (contact_id);

      -- One run per enrollment step; owns waiting inside the step (ADR 021 section 1).
      CREATE TABLE workflow_runs (
        id                 TEXT PRIMARY KEY,
        workflow_type      TEXT NOT NULL,
        definition_version INTEGER NOT NULL,
        business_type      TEXT NOT NULL,
        business_id        TEXT NOT NULL,
        step_position      INTEGER,
        status             TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting_approval',
                             'waiting_for_human', 'waiting_external', 'paused', 'completed', 'failed', 'cancelled')),
        current_state      TEXT NOT NULL,
        context            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context)),
        correlation_id     TEXT NOT NULL,
        lock_version       INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      ) STRICT;
      CREATE INDEX workflow_runs_business ON workflow_runs (business_type, business_id, step_position);
      CREATE INDEX workflow_runs_status ON workflow_runs (status);

      CREATE TABLE workflow_step_runs (
        id                     TEXT PRIMARY KEY,
        workflow_run_id        TEXT NOT NULL REFERENCES workflow_runs (id),
        state                  TEXT NOT NULL,
        attempt                INTEGER NOT NULL,
        status                 TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        input_hash             TEXT,
        result                 TEXT CHECK (result IS NULL OR json_valid(result)),
        started_at             TEXT NOT NULL,
        completed_at           TEXT,
        error_code             TEXT,
        error_message_redacted TEXT,
        UNIQUE (workflow_run_id, state, attempt)
      ) STRICT;

      CREATE TABLE message_drafts (
        id                     TEXT PRIMARY KEY,
        contact_id             TEXT REFERENCES contacts (id),
        company_id             TEXT REFERENCES companies (id) ON DELETE SET NULL,
        campaign_enrollment_id TEXT REFERENCES campaign_enrollments (id),
        workflow_run_id        TEXT REFERENCES workflow_runs (id),
        channel                TEXT NOT NULL,
        subject                TEXT,
        body                   TEXT NOT NULL,
        fact_ids               TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fact_ids)),
        generation_meta        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(generation_meta)),
        content_hash           TEXT NOT NULL,
        version                INTEGER NOT NULL,
        created_at             TEXT NOT NULL,
        CHECK (contact_id IS NOT NULL OR company_id IS NOT NULL),
        UNIQUE (workflow_run_id, version)
      ) STRICT;

      -- Approvals are rows with a lifecycle (ADR 021 section 4).
      CREATE TABLE approvals (
        id                     TEXT PRIMARY KEY,
        workflow_run_id        TEXT NOT NULL REFERENCES workflow_runs (id),
        campaign_enrollment_id TEXT REFERENCES campaign_enrollments (id),
        message_draft_id       TEXT REFERENCES message_drafts (id),
        draft_version          INTEGER,
        target_snapshot        TEXT NOT NULL CHECK (json_valid(target_snapshot)),
        content_hash           TEXT NOT NULL,
        scope                  TEXT NOT NULL CHECK (scope IN ('single_action', 'campaign')),
        status                 TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'skipped',
                                 'superseded', 'expired')),
        decided_by             TEXT CHECK (decided_by IN ('user', 'campaign_policy')),
        decided_at             TEXT,
        expires_at             TEXT,
        created_at             TEXT NOT NULL
      ) STRICT;
      CREATE INDEX approvals_status ON approvals (status, created_at);
      CREATE INDEX approvals_run ON approvals (workflow_run_id);
    `,
  },
  {
    version: 9,
    name: 'channel_accounts',
    sql: `
      -- Sending accounts (docs/05, docs/14). Secrets live in \`secrets\`; metadata holds only
      -- non-secret settings (hosts, ports, username).
      CREATE TABLE channel_accounts (
        id                  TEXT PRIMARY KEY,
        channel             TEXT NOT NULL CHECK (channel IN ('email', 'linkedin')),
        provider            TEXT NOT NULL CHECK (provider IN ('imap_smtp', 'gmail_api', 'linkedin_browser')),
        display_name        TEXT NOT NULL,
        external_account_id TEXT NOT NULL,
        browser_profile_id  TEXT,
        secret_id           TEXT REFERENCES secrets (id) ON DELETE SET NULL,
        limits              TEXT NOT NULL CHECK (json_valid(limits)),
        status              TEXT NOT NULL CHECK (status IN ('active', 'auth_required', 'disabled')),
        metadata            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX channel_accounts_identity ON channel_accounts (channel, provider, external_account_id)
        WHERE status != 'disabled';

      -- Pacing is per sending account; the account is not part of the intent key.
      ALTER TABLE side_effects ADD COLUMN channel_account_id TEXT;
      CREATE INDEX side_effects_account ON side_effects (channel_account_id, status, updated_at);
    `,
  },
  {
    version: 10,
    name: 'conversations',
    sql: `
      -- Email conversations (docs/05, docs/14): one per account and contact, or per account and
      -- company for a possible reply that only matched the company domain.
      CREATE TABLE conversations (
        id                     TEXT PRIMARY KEY,
        channel                TEXT NOT NULL CHECK (channel IN ('email', 'linkedin')),
        channel_account_id     TEXT NOT NULL REFERENCES channel_accounts (id),
        contact_id             TEXT REFERENCES contacts (id),
        company_id             TEXT REFERENCES companies (id) ON DELETE SET NULL,
        campaign_enrollment_id TEXT REFERENCES campaign_enrollments (id),
        provider_thread_id     TEXT,
        status                 TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'archived')),
        unread                 INTEGER NOT NULL DEFAULT 0 CHECK (unread IN (0, 1)),
        last_message_at        TEXT NOT NULL,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        CHECK (contact_id IS NOT NULL OR company_id IS NOT NULL)
      ) STRICT;
      CREATE UNIQUE INDEX conversations_contact ON conversations (channel_account_id, contact_id)
        WHERE contact_id IS NOT NULL;
      CREATE UNIQUE INDEX conversations_company ON conversations (channel_account_id, company_id)
        WHERE contact_id IS NULL;
      CREATE INDEX conversations_recent ON conversations (last_message_at);

      CREATE TABLE messages (
        id                  TEXT PRIMARY KEY,
        conversation_id     TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        direction           TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        rfc_message_id      TEXT,
        provider_message_id TEXT,
        in_reply_to         TEXT,
        from_address        TEXT,
        subject             TEXT,
        body                TEXT,
        classification      TEXT CHECK (classification IN ('reply', 'out_of_office', 'auto', 'bounce')),
        match_strength      TEXT CHECK (match_strength IN ('thread', 'contact_address', 'domain_only')),
        review_status       TEXT NOT NULL DEFAULT 'none' CHECK (review_status IN ('none', 'pending', 'confirmed', 'dismissed')),
        metadata            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
        occurred_at         TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        UNIQUE (conversation_id, provider_message_id)
      ) STRICT;
      CREATE INDEX messages_rfc ON messages (rfc_message_id);
      CREATE INDEX messages_conversation ON messages (conversation_id, occurred_at);

      -- Where polling left off in each account's inbox (IMAP UIDVALIDITY + last seen UID).
      CREATE TABLE mailbox_cursors (
        channel_account_id TEXT PRIMARY KEY REFERENCES channel_accounts (id),
        folder             TEXT NOT NULL,
        uid_validity       INTEGER,
        last_uid           INTEGER,
        last_polled_at     TEXT,
        last_error         TEXT
      ) STRICT;
    `,
  },
  {
    version: 11,
    name: 'reply_hold',
    sql: `
      -- A contact who replied is not contacted again by any campaign until the user allows it;
      -- replies received before this moment no longer hold them (audit 3.5).
      ALTER TABLE contacts ADD COLUMN reply_hold_released_at TEXT;
    `,
  },
  {
    version: 12,
    name: 'ai_calls',
    sql: `
      -- One row per AI provider call (docs/15 "Logging"): no prompts, no content, only what it cost.
      CREATE TABLE ai_calls (
        id               TEXT PRIMARY KEY,
        use_case         TEXT NOT NULL CHECK (use_case IN ('classification', 'research', 'drafting')),
        provider         TEXT NOT NULL,
        model            TEXT NOT NULL,
        template_key     TEXT NOT NULL,
        template_version INTEGER NOT NULL,
        status           TEXT NOT NULL CHECK (status IN ('ok', 'invalid_output', 'error', 'refused')),
        input_tokens     INTEGER NOT NULL DEFAULT 0,
        output_tokens    INTEGER NOT NULL DEFAULT 0,
        cost_usd         REAL,
        latency_ms       INTEGER NOT NULL DEFAULT 0,
        error_class      TEXT,
        correlation_id   TEXT NOT NULL,
        created_at       TEXT NOT NULL
      ) STRICT;
      CREATE INDEX ai_calls_month ON ai_calls (created_at);

      -- What AI read in a reply, with the template that produced it (docs/15 "Prompt versioning").
      ALTER TABLE messages ADD COLUMN ai_label TEXT
        CHECK (ai_label IN ('interested', 'not_interested', 'opt_out', 'out_of_office', 'other'));
      ALTER TABLE messages ADD COLUMN ai_confidence REAL;
      ALTER TABLE messages ADD COLUMN ai_template TEXT;
    `,
  },
  {
    version: 13,
    name: 'research',
    sql: `
      -- Research (docs/16). Evidence is stored once per content hash and linked to runs.
      CREATE TABLE research_runs (
        id                   TEXT PRIMARY KEY,
        company_id           TEXT NOT NULL REFERENCES companies (id),
        status               TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
        error                TEXT,
        criteria             TEXT,
        summary              TEXT,
        qualification        TEXT CHECK (qualification IN ('match', 'possible_match', 'not_match', 'insufficient_data')),
        qualification_reason TEXT,
        reason_to_contact    TEXT,
        missing_information  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(missing_information)),
        template             TEXT,
        model                TEXT,
        pages_fetched        INTEGER NOT NULL DEFAULT 0,
        pages_skipped        INTEGER NOT NULL DEFAULT 0,
        correlation_id       TEXT NOT NULL,
        started_at           TEXT NOT NULL,
        finished_at          TEXT
      ) STRICT;
      CREATE INDEX research_runs_company ON research_runs (company_id, started_at);

      CREATE TABLE evidence (
        id           TEXT PRIMARY KEY,
        url          TEXT NOT NULL,
        title        TEXT,
        content_hash TEXT NOT NULL UNIQUE,
        text         TEXT NOT NULL,
        extractor    TEXT NOT NULL,
        captured_at  TEXT NOT NULL
      ) STRICT;

      CREATE TABLE research_run_evidence (
        research_run_id TEXT NOT NULL REFERENCES research_runs (id) ON DELETE CASCADE,
        evidence_id     TEXT NOT NULL REFERENCES evidence (id),
        PRIMARY KEY (research_run_id, evidence_id)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE research_facts (
        id              TEXT PRIMARY KEY,
        research_run_id TEXT NOT NULL REFERENCES research_runs (id) ON DELETE CASCADE,
        position        INTEGER NOT NULL,
        kind            TEXT NOT NULL CHECK (kind IN ('fact', 'inference')),
        claim           TEXT NOT NULL,
        evidence_id     TEXT REFERENCES evidence (id),
        quote           TEXT,
        verified        INTEGER NOT NULL CHECK (verified IN (0, 1)),
        based_on        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(based_on)),
        created_at      TEXT NOT NULL
      ) STRICT;
      CREATE INDEX research_facts_run ON research_facts (research_run_id, position);
    `,
  },
  {
    version: 14,
    name: 'draft_checks',
    sql: `
      -- Who wrote each draft version (docs/17, ADR 025). Versions before this were the step template
      -- or a person's edit; they read as 'template'.
      ALTER TABLE message_drafts ADD COLUMN origin TEXT NOT NULL DEFAULT 'template'
        CHECK (origin IN ('template', 'ai', 'user'));

      -- Automated checks, for exactly one draft version (its content never changes).
      CREATE TABLE draft_checks (
        message_draft_id TEXT NOT NULL REFERENCES message_drafts (id) ON DELETE CASCADE,
        check_key        TEXT NOT NULL CHECK (check_key IN ('grounding', 'length', 'forbidden_phrases', 'links',
                           'signature', 'target')),
        passed           INTEGER NOT NULL CHECK (passed IN (0, 1)),
        detail           TEXT,
        created_at       TEXT NOT NULL,
        PRIMARY KEY (message_draft_id, check_key)
      ) STRICT, WITHOUT ROWID;
    `,
  },
  {
    version: 15,
    name: 'browser_profiles',
    sql: `
      -- Browser profiles (docs/08) and their sessions (docs/11), Phase 5a. The profile directory is
      -- derived from the id (<data>/profiles/<id>); no path is stored.
      CREATE TABLE browser_profiles (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        purpose              TEXT NOT NULL CHECK (purpose IN ('channel_identity', 'research', 'general')),
        channel_account_id   TEXT REFERENCES channel_accounts (id),
        status               TEXT NOT NULL CHECK (status IN ('ready', 'open', 'needs_login', 'unhealthy', 'archived')),
        browser_channel      TEXT NOT NULL DEFAULT 'chrome' CHECK (browser_channel IN ('chrome', 'chromium')),
        locale               TEXT,
        timezone             TEXT,
        health               TEXT CHECK (health IS NULL OR json_valid(health)),
        last_opened_at       TEXT,
        last_health_check_at TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      ) STRICT;

      CREATE TABLE browser_sessions (
        id                 TEXT PRIMARY KEY,
        browser_profile_id TEXT NOT NULL REFERENCES browser_profiles (id) ON DELETE CASCADE,
        control_mode       TEXT NOT NULL CHECK (control_mode IN ('automation', 'paused', 'human')),
        status             TEXT NOT NULL CHECK (status IN ('opening', 'open', 'closed', 'interrupted')),
        current_url        TEXT,
        started_at         TEXT NOT NULL,
        ended_at           TEXT,
        heartbeat_at       TEXT
      ) STRICT;
      CREATE INDEX browser_sessions_profile ON browser_sessions (browser_profile_id, started_at);
      CREATE INDEX browser_sessions_live ON browser_sessions (status);
    `,
  },
  {
    version: 16,
    name: 'browser_tasks',
    sql: `
      -- One unit of browser work and its result (docs/07, docs/13 ownership map), Phase 5b.
      CREATE TABLE browser_tasks (
        id                   TEXT PRIMARY KEY,
        workflow_run_id      TEXT NOT NULL REFERENCES workflow_runs (id),
        task_type            TEXT NOT NULL,
        browser_profile_id   TEXT NOT NULL REFERENCES browser_profiles (id) ON DELETE CASCADE,
        browser_session_id   TEXT REFERENCES browser_sessions (id) ON DELETE SET NULL,
        adapter_pack_id      TEXT,
        adapter_pack_version TEXT,
        status               TEXT NOT NULL CHECK (status IN ('dispatched', 'running', 'succeeded', 'failed',
                               'unsupported_state', 'needs_human', 'unknown', 'interrupted')),
        checkpoint           TEXT CHECK (checkpoint IS NULL OR json_valid(checkpoint)),
        result               TEXT CHECK (result IS NULL OR json_valid(result)),
        dispatched_at        TEXT NOT NULL,
        finished_at          TEXT
      ) STRICT;
      CREATE INDEX browser_tasks_run ON browser_tasks (workflow_run_id, dispatched_at);

      -- A request to the user (docs/11 "Intervention record") and how it ended.
      CREATE TABLE human_interventions (
        id                 TEXT PRIMARY KEY,
        workflow_run_id    TEXT NOT NULL REFERENCES workflow_runs (id),
        browser_session_id TEXT REFERENCES browser_sessions (id) ON DELETE SET NULL,
        browser_profile_id TEXT REFERENCES browser_profiles (id) ON DELETE CASCADE,
        browser_task_id    TEXT REFERENCES browser_tasks (id) ON DELETE SET NULL,
        reason             TEXT NOT NULL CHECK (reason IN ('security_challenge', 'login_required', 'unsupported_state')),
        status             TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'cancelled')),
        resolution         TEXT CHECK (resolution IS NULL OR json_valid(resolution)),
        requested_at       TEXT NOT NULL,
        resolved_at        TEXT
      ) STRICT;
      CREATE INDEX human_interventions_open ON human_interventions (status, requested_at);
    `,
  },
  {
    version: 17,
    name: 'intervention_user_control',
    foreignKeysOff: true,
    sql: `
      -- A person taking control (or pausing from the page) is a reason to wait too (Phase 5c).
      CREATE TABLE human_interventions_new (
        id                 TEXT PRIMARY KEY,
        workflow_run_id    TEXT NOT NULL REFERENCES workflow_runs (id),
        browser_session_id TEXT REFERENCES browser_sessions (id) ON DELETE SET NULL,
        browser_profile_id TEXT REFERENCES browser_profiles (id) ON DELETE CASCADE,
        browser_task_id    TEXT REFERENCES browser_tasks (id) ON DELETE SET NULL,
        reason             TEXT NOT NULL CHECK (reason IN ('security_challenge', 'login_required', 'unsupported_state',
                             'user_control')),
        status             TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'cancelled')),
        resolution         TEXT CHECK (resolution IS NULL OR json_valid(resolution)),
        requested_at       TEXT NOT NULL,
        resolved_at        TEXT
      ) STRICT;
      INSERT INTO human_interventions_new SELECT * FROM human_interventions;
      DROP TABLE human_interventions;
      ALTER TABLE human_interventions_new RENAME TO human_interventions;
      CREATE INDEX human_interventions_open ON human_interventions (status, requested_at);
    `,
  },
  {
    version: 18,
    name: 'form_preparations',
    sql: `
      -- A contact form found, mapped and filled for one draft of a message step (Phase 6): what the
      -- approval shows, and exactly what the send writes into the form.
      CREATE TABLE form_preparations (
        id               TEXT PRIMARY KEY,
        workflow_run_id  TEXT NOT NULL REFERENCES workflow_runs (id),
        message_draft_id TEXT NOT NULL REFERENCES message_drafts (id),
        status           TEXT NOT NULL CHECK (status IN ('ready', 'needs_human')),
        reason           TEXT,
        form_url         TEXT NOT NULL,
        opener           TEXT,
        signature        TEXT NOT NULL,
        fields           TEXT NOT NULL CHECK (json_valid(fields)),
        challenge        TEXT,
        -- auto or assisted: a person presses Send when a field, a consent or a challenge needs them.
        mode             TEXT NOT NULL CHECK (mode IN ('auto', 'assisted')),
        screenshot       BLOB,
        pack_version     TEXT NOT NULL,
        prepared_at      TEXT NOT NULL
      ) STRICT;
      CREATE INDEX form_preparations_run ON form_preparations (workflow_run_id, prepared_at);
    `,
  },
];
