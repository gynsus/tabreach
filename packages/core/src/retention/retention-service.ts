import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  RETENTION_DEFAULTS,
  uuidv7,
  retentionReportSchema,
  retentionSettingsSchema,
  type Logger,
  type RetentionReport,
  type RetentionSettings,
} from '@tabreach/protocol';
import { z } from 'zod';
import type { AuditLog } from '../audit/audit-log.js';
import { transaction } from '../db/database.js';
import type { JobQueue } from '../jobs/queue.js';
import type { JobType } from '../jobs/dispatcher.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import type { SettingsRepository } from '../settings/settings.js';

const SETTINGS_KEY = 'retention';
const REPORT_KEY = 'retention.lastRun';
const JOB = 'retention.prune';
const DAY_MS = 24 * 60 * 60_000;
/** Runs whose texts are no longer needed: their step is over, whatever the outcome. */
const TERMINAL_RUNS = `('completed', 'failed', 'cancelled')`;
/** Enrollments still going on: their earlier messages are context for the next step's draft. */
const LIVE_ENROLLMENTS = `('active', 'paused')`;

/**
 * Data retention (docs/18, Phase 8a-3): how long screenshots, browser diagnostics, message texts,
 * research evidence and old logs are kept, and a daily job that removes what is older. It removes
 * or blanks content only — rows, ids, codes, hashes and the audit trail stay, so the ledger still
 * guards every send. A text is blanked only once its step is over (a pending approval or a send
 * in progress still needs it) and the contact's sequence has ended (the next step's draft reads
 * the earlier messages).
 */
export class RetentionService {
  constructor(
    private readonly d: {
      db: DatabaseSync;
      now: () => Date;
      settings: SettingsRepository;
      audit: AuditLog;
      jobs: JobQueue;
      logger: Logger;
      /** The worker's screenshots of unrecognized pages. */
      diagnosticsDir: string | null;
      /** Where the processes write their logs; rotated files there are pruned. */
      logDir: string | null;
    },
  ) {}

  settings(): RetentionSettings {
    return this.d.settings.get(SETTINGS_KEY, retentionSettingsSchema) ?? RETENTION_DEFAULTS;
  }

  lastRun(): RetentionReport | null {
    return this.d.settings.get(REPORT_KEY, retentionReportSchema) ?? null;
  }

  update(next: RetentionSettings, ctx: CommandContext): RetentionSettings {
    const value = retentionSettingsSchema.parse(next);
    transaction(this.d.db, () => {
      this.d.settings.set(SETTINGS_KEY, value);
      this.d.audit.record({
        actorType: 'user',
        actionType: 'retention.updated',
        objectType: 'settings',
        objectId: SETTINGS_KEY,
        payload: value,
        correlationId: ctx.correlationId,
      });
    });
    // Shorter now: apply it soon rather than tomorrow.
    this.schedule(new Date(this.d.now().getTime() + 60_000), true);
    return value;
  }

  /** Keeps one pruning job alive (core start); it reschedules itself daily. */
  schedule(at: Date = new Date(this.d.now().getTime() + 5 * 60_000), sooner = false): void {
    const job = this.d.jobs.latestFor(JOB, 'kind', 'daily');
    if (job && (job.status === 'pending' || job.status === 'running')) {
      if (sooner && job.status === 'pending') this.d.jobs.reschedule(job.id, at);
      return;
    }
    this.d.jobs.enqueue(JOB, { kind: 'daily' }, { runAt: at, dedupeKey: `${JOB}:${at.toISOString()}` });
  }

  jobTypes(): JobType<never>[] {
    const type: JobType<{ kind: 'daily' }> = {
      type: JOB,
      payload: z.object({ kind: z.literal('daily') }),
      sideEffecting: false,
      maxAttempts: 3,
      handler: async () => {
        await this.prune();
        return { continueAt: new Date(this.d.now().getTime() + DAY_MS) };
      },
    };
    return [type] as unknown as JobType<never>[];
  }

  /** One pass over every kind; returns and records what it removed (counts only). */
  async prune(): Promise<RetentionReport> {
    const s = this.settings();
    const now = this.d.now();
    const cutoff = (days: number | null) =>
      days === null ? null : new Date(now.getTime() - days * DAY_MS).toISOString();
    const report: RetentionReport = {
      ranAt: now.toISOString(),
      screenshots: 0,
      browserDiagnostics: 0,
      messageBodies: 0,
      researchEvidence: 0,
      logs: 0,
    };

    const shots = cutoff(s.screenshots);
    if (shots) {
      report.screenshots += this.run(
        `UPDATE form_preparations SET screenshot = NULL WHERE screenshot IS NOT NULL AND prepared_at < ?`,
        shots,
      );
      report.screenshots += await removeOldFiles(this.d.diagnosticsDir, shots, (name) =>
        name.endsWith('.png'),
      );
    }

    const diagnostics = cutoff(s.browserDiagnostics);
    if (diagnostics) {
      // The page's title, address and snapshot go; states, codes and the screenshot's name stay.
      report.browserDiagnostics += this.run(
        `UPDATE browser_tasks
         SET result = json_set(result, '$.url', NULL, '$.diagnostics.title', NULL,
                               '$.diagnostics.url', NULL, '$.diagnostics.ariaSnapshot', '')
         WHERE dispatched_at < ? AND result IS NOT NULL
           AND (json_extract(result, '$.diagnostics.ariaSnapshot') != ''
                OR json_extract(result, '$.diagnostics.title') IS NOT NULL
                OR json_extract(result, '$.url') IS NOT NULL)`,
        diagnostics,
      );
    }

    const bodies = cutoff(s.messageBodies);
    if (bodies) {
      report.messageBodies += this.run(
        `UPDATE message_drafts SET body = '', subject = NULL
         WHERE body != '' AND created_at < ?
           AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id = message_drafts.workflow_run_id
                           AND r.status NOT IN ${TERMINAL_RUNS})
           AND NOT EXISTS (SELECT 1 FROM campaign_enrollments e WHERE e.id = message_drafts.campaign_enrollment_id
                           AND e.status IN ${LIVE_ENROLLMENTS})`,
        bodies,
      );
      report.messageBodies += this.run(
        `UPDATE form_preparations SET fields = '[]'
         WHERE fields != '[]' AND prepared_at < ?
           AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id = form_preparations.workflow_run_id
                           AND (r.status NOT IN ${TERMINAL_RUNS}
                                OR EXISTS (SELECT 1 FROM campaign_enrollments e WHERE e.id = r.business_id
                                           AND e.status IN ${LIVE_ENROLLMENTS})))`,
        bodies,
      );
      report.messageBodies += this.run(
        `UPDATE messages SET body = NULL WHERE body IS NOT NULL AND occurred_at < ?`,
        bodies,
      );
    }

    const evidence = cutoff(s.researchEvidence);
    if (evidence) {
      report.researchEvidence += this.run(
        `UPDATE evidence SET text = '' WHERE text != '' AND captured_at < ?`,
        evidence,
      );
    }

    const logs = cutoff(s.logs);
    if (logs) {
      // Only rotated generations (`core.1.log`); a process's current log is never touched.
      report.logs += await removeOldFiles(this.d.logDir, logs, (name) => /\.\d+\.log$/.test(name));
    }

    this.d.settings.set(REPORT_KEY, report);
    const removed =
      report.screenshots +
      report.browserDiagnostics +
      report.messageBodies +
      report.researchEvidence +
      report.logs;
    if (removed > 0) {
      this.d.audit.record({
        actorType: 'system',
        actionType: 'retention.pruned',
        objectType: 'settings',
        objectId: SETTINGS_KEY,
        payload: report,
        correlationId: uuidv7(),
      });
      this.d.logger.info({ event: 'retention.pruned', ...report }, 'old data removed');
    }
    return report;
  }

  private run(sql: string, cutoff: string): number {
    return Number(this.d.db.prepare(sql).run(cutoff).changes);
  }
}

/** Removes files in `dir` last modified before `cutoff` whose names match; returns how many. */
async function removeOldFiles(
  dir: string | null,
  cutoff: string,
  matches: (name: string) => boolean,
): Promise<number> {
  if (!dir) return 0;
  const before = new Date(cutoff).getTime();
  const names = await readdir(dir).catch(() => [] as string[]); // absent until first written
  let removed = 0;
  for (const name of names.filter(matches)) {
    const file = join(dir, name);
    const info = await stat(file).catch(() => null);
    if (info?.isFile() && info.mtimeMs < before) {
      await rm(file, { force: true });
      removed++;
    }
  }
  return removed;
}
