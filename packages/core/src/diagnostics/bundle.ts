import { existsSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { zipSync, strToU8 } from 'fflate';
import {
  diagnosticsFileSchema,
  redactDeep,
  scrubString,
  type DiagnosticScreenshot,
  type DiagnosticsBundle,
  type HealthReport,
} from '@tabreach/protocol';

/** How far back state and events go into a bundle, and how much of each log. */
const WINDOW_MS = 14 * 24 * 60 * 60_000;
const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const LOG_FILES = ['main.log', 'core.log', 'worker.log'];
/** Screenshots are listed while the worker keeps them (30 days, docs/07). */
const SCREENSHOT_WINDOW_MS = 30 * 24 * 60 * 60_000;

/**
 * The sanitized diagnostics bundle (docs/20 "Diagnostics bundle", FR-BRA-007): versions, the tail
 * of the redacted logs, action events, workflow/job/browser-task state and the screenshots the
 * person chose. Built from codes, ids and statuses only: no `secrets` table, no message bodies,
 * no addresses, names or page URLs, no cookies, nothing from browser profile directories. Nothing
 * is uploaded; the person saves the zip and decides where it goes.
 */
export class DiagnosticsService {
  constructor(
    private readonly d: {
      db: DatabaseSync;
      now: () => Date;
      /** Where the processes write their logs; null when unknown (tests). */
      logDir: string | null;
      /** Where the worker keeps masked screenshots of unrecognized pages. */
      diagnosticsDir: string;
      health: () => Promise<HealthReport>;
      packs: () => { id: string; version: string }[];
    },
  ) {}

  /** Screenshots that can go into a bundle: kept by the worker for a task in the last 30 days. */
  screenshots(): DiagnosticScreenshot[] {
    const since = new Date(this.d.now().getTime() - SCREENSHOT_WINDOW_MS).toISOString();
    const rows = this.d.db
      .prepare(
        `SELECT adapter_pack_id, result, finished_at, dispatched_at FROM browser_tasks
         WHERE dispatched_at > ? AND result IS NOT NULL ORDER BY dispatched_at DESC`,
      )
      .all(since) as {
      adapter_pack_id: string | null;
      result: string;
      finished_at: string | null;
      dispatched_at: string;
    }[];
    return rows.flatMap((row) => {
      const result = parseObject(row.result);
      const diagnostics = result?.diagnostics as { screenshot?: unknown } | null | undefined;
      const file = diagnosticsFileSchema.safeParse(diagnostics?.screenshot);
      if (!file.success || !existsSync(join(this.d.diagnosticsDir, file.data))) return [];
      return [
        {
          file: file.data,
          takenAt: row.finished_at ?? row.dispatched_at,
          packId: row.adapter_pack_id,
          stateId: typeof result?.stateId === 'string' ? result.stateId : null,
          errorKey: typeof result?.errorKey === 'string' ? result.errorKey : null,
        },
      ];
    });
  }

  async createBundle(req: { screenshots: string[] }): Promise<DiagnosticsBundle> {
    const now = this.d.now();
    const since = new Date(now.getTime() - WINDOW_MS).toISOString();
    const files: Record<string, Uint8Array> = {};
    const json = (name: string, value: unknown) => {
      files[name] = strToU8(`${JSON.stringify(redactDeep(value, 12), null, 2)}\n`);
    };

    const health = await this.d.health();
    json('manifest.json', {
      createdAt: now.toISOString(),
      app: health.app,
      worker: health.worker,
      database: health.database,
      os: { platform: platform(), release: release(), arch: arch() },
      adapterPacks: this.d.packs(),
      window: { since },
      excluded: [
        'secrets table and every decrypted secret',
        'OAuth tokens, API keys, passwords, cookies',
        'browser profile directories',
        'message bodies, names, addresses and page URLs',
      ],
    });
    json('state.json', this.state(since));
    json('events.json', this.events(since));
    for (const name of LOG_FILES) {
      const tail = this.d.logDir ? await logTail(join(this.d.logDir, name)) : null;
      if (tail !== null) files[`logs/${name}`] = strToU8(tail);
    }
    // Only screenshots this app keeps for its own tasks, by their exact names: no path from outside.
    const known = new Set(this.screenshots().map((s) => s.file));
    for (const file of req.screenshots) {
      if (!known.has(file)) continue;
      files[`screenshots/${file}`] = new Uint8Array(await readFile(join(this.d.diagnosticsDir, file)));
    }

    const zip = zipSync(files, { level: 6 });
    const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return {
      filename: `tabreach-diagnostics-${stamp}.zip`,
      base64: Buffer.from(zip).toString('base64'),
      bytes: zip.byteLength,
      contents: Object.keys(files).sort(),
    };
  }

  /** Workflow, job, send and browser-task state: statuses, codes and ids. */
  private state(since: string): Record<string, unknown> {
    const all = (sql: string, ...params: string[]) => this.d.db.prepare(sql).all(...params);
    return {
      workflowRuns: all(
        `SELECT id, workflow_type, status, current_state, step_position, created_at, updated_at
         FROM workflow_runs
         WHERE updated_at > ? OR status NOT IN ('completed', 'failed', 'cancelled')
         ORDER BY updated_at DESC LIMIT 500`,
        since,
      ),
      jobs: all(
        `SELECT id, type, status, attempts, max_attempts, run_at, last_error_class, last_error_redacted,
                correlation_id, created_at, updated_at
         FROM jobs WHERE updated_at > ? OR status IN ('pending', 'running', 'failed', 'dead')
         ORDER BY updated_at DESC LIMIT 500`,
        since,
      ),
      sends: all(
        `SELECT id, channel, action_type, status, error_class, reconciled_by, workflow_run_id,
                created_at, updated_at
         FROM side_effects WHERE updated_at > ? OR status IN ('executing', 'unknown')
         ORDER BY updated_at DESC LIMIT 500`,
        since,
      ),
      browserTasks: (
        all(
          `SELECT id, workflow_run_id, task_type, adapter_pack_id, adapter_pack_version, status,
                  checkpoint, result, dispatched_at, finished_at
           FROM browser_tasks WHERE dispatched_at > ? ORDER BY dispatched_at DESC LIMIT 500`,
          since,
        ) as Record<string, unknown>[]
      ).map(({ result, checkpoint, ...task }) => ({
        ...task,
        checkpoint: parseObject(checkpoint),
        result: taskOutcome(parseObject(result)),
      })),
      interventions: all(
        `SELECT id, workflow_run_id, reason, status, resolution, requested_at, resolved_at
         FROM human_interventions WHERE requested_at > ? OR status = 'open'
         ORDER BY requested_at DESC LIMIT 200`,
        since,
      ),
    };
  }

  /** The action timeline: ids, codes and redacted payloads, which carry no personal data (ADR 022). */
  private events(since: string): unknown[] {
    return (
      this.d.db
        .prepare(
          `SELECT id, correlation_id, causation_id, actor_type, action_type, object_type, object_id,
                  status, adapter_pack_version, payload_redacted, created_at
           FROM action_events WHERE created_at > ? ORDER BY created_at DESC LIMIT 5000`,
        )
        .all(since) as Record<string, unknown>[]
    ).map(({ payload_redacted, ...event }) => ({ ...event, payload: parseObject(payload_redacted) }));
  }
}

/** A browser task's result without what could name a person: no URL, no page title or snapshot. */
function taskOutcome(result: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!result) return null;
  const diagnostics = result.diagnostics as { expectedStates?: unknown } | null | undefined;
  return {
    status: result.status ?? null,
    stateId: result.stateId ?? null,
    stateKind: result.stateKind ?? null,
    errorKey: result.errorKey ?? null,
    committed: result.committed ?? null,
    packVersion: result.packVersion ?? null,
    expectedStates: diagnostics?.expectedStates ?? null,
  };
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The end of a log, redacted once more on the way out: every JSON line through `redactDeep`, any
 * other line through `scrubString` (logs are redacted when written; this guards older lines).
 */
async function logTail(file: string): Promise<string | null> {
  const size = await stat(file).then(
    (s) => s.size,
    () => null,
  );
  if (size === null) return null;
  const start = Math.max(0, size - LOG_TAIL_BYTES);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines = lines.slice(1); // the first line was cut in the middle
    return lines
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const parsed = parseObject(line);
        return parsed ? JSON.stringify(redactDeep(parsed, 12)) : scrubString(line);
      })
      .join('\n')
      .concat('\n');
  } finally {
    await handle.close();
  }
}
