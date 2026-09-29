import type { DatabaseSync } from 'node:sqlite';
import {
  RpcError,
  uuidv7,
  type BrowserProfile,
  type ChangedEntity,
  type ControlMode,
  type Logger,
  type ProfileHealthStatus,
  type ProfilePurpose,
  type ProfileStatus,
  type RpcPeer,
  type SessionChanged,
  type SessionStatus,
} from '@tabreach/protocol';
import type { AuditLog } from '../audit/audit-log.js';
import { transaction } from '../db/database.js';
import type { CommandContext } from '../prospects/prospect-service.js';

/** A session still `opening` longer than this without the worker knowing it is gone. */
const OPENING_GRACE_MS = 120_000;
const OPEN_TIMEOUT_MS = 90_000;

interface ProfileRow {
  id: string;
  name: string;
  purpose: ProfilePurpose;
  status: ProfileStatus;
  browser_channel: 'chrome' | 'chromium';
  health: string | null;
  last_opened_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  browser_profile_id: string;
  control_mode: ControlMode;
  status: SessionStatus;
  current_url: string | null;
  started_at: string;
  heartbeat_at: string | null;
}

type Worker = Pick<RpcPeer, 'request'>;

/**
 * Browser profiles and sessions (docs/08, docs/11, Phase 5a). Core owns the records; the worker
 * runs Chrome and reports what happens to it. A profile opened from the app is under the user's
 * control (`human`): no automation may act in it.
 */
export class BrowserService {
  constructor(
    private readonly d: {
      db: DatabaseSync;
      now: () => Date;
      audit: AuditLog;
      worker: () => Worker | null;
      changed: (entities: ChangedEntity[]) => void;
      logger: Logger;
      /** `chromium` in tests; the user's Google Chrome in the app. */
      browserChannel?: 'chrome' | 'chromium';
    },
  ) {}

  list(includeArchived: boolean): BrowserProfile[] {
    const rows = this.d.db
      .prepare(
        `SELECT * FROM browser_profiles ${includeArchived ? '' : "WHERE status != 'archived'"} ORDER BY created_at`,
      )
      .all() as unknown as ProfileRow[];
    return rows.map((r) => this.dto(r));
  }

  get(id: string): BrowserProfile {
    return this.dto(this.row(id));
  }

  create(input: { name: string; purpose: 'general' | 'research' }, ctx: CommandContext): BrowserProfile {
    const id = uuidv7();
    const ts = this.d.now().toISOString();
    this.d.db
      .prepare(
        `INSERT INTO browser_profiles (id, name, purpose, status, browser_channel, created_at, updated_at)
         VALUES (?, ?, ?, 'ready', ?, ?, ?)`,
      )
      .run(id, input.name.trim(), input.purpose, this.d.browserChannel ?? 'chrome', ts, ts);
    this.record('profile.created', id, ctx, { purpose: input.purpose });
    return this.get(id);
  }

  rename(id: string, name: string, ctx: CommandContext): BrowserProfile {
    this.row(id);
    this.d.db
      .prepare('UPDATE browser_profiles SET name = ?, updated_at = ? WHERE id = ?')
      .run(name.trim(), this.d.now().toISOString(), id);
    this.record('profile.updated', id, ctx, { fields: ['name'] });
    return this.get(id);
  }

  archive(id: string, ctx: CommandContext): BrowserProfile {
    if (this.liveSession(id)) throw conflict('profile.open');
    this.setStatus(id, 'archived');
    this.record('profile.archived', id, ctx);
    return this.get(id);
  }

  /** Destroys the signed-in state: only when closed, and after the user typed the name (docs/08). */
  async delete(id: string, confirmName: string, ctx: CommandContext): Promise<void> {
    const row = this.row(id);
    if (confirmName.trim() !== row.name) throw RpcError.validation({ confirmName: 'profile.nameMismatch' });
    if (this.liveSession(id)) throw conflict('profile.open');
    await this.requireWorker().request('profile.delete', { profileId: id });
    transaction(this.d.db, () => {
      this.d.db.prepare('DELETE FROM browser_profiles WHERE id = ?').run(id);
      this.record('profile.deleted', id, ctx);
    });
  }

  /** Opens a visible Chrome window with the profile, under the user's control. */
  async open(id: string, startUrl: string | null, ctx: CommandContext): Promise<BrowserProfile> {
    await this.openSession(id, 'human', startUrl, ctx.correlationId);
    this.record('profile.opened', id, ctx);
    return this.get(id);
  }

  /**
   * Starts Chrome with the profile. `human`: the user's window; `automation`: a browser task's
   * (docs/11). Returns the session id.
   */
  async openSession(
    id: string,
    controlMode: ControlMode,
    startUrl: string | null,
    correlationId: string,
  ): Promise<string> {
    const row = this.row(id);
    if (row.status === 'archived') throw conflict('profile.archived');
    if (this.liveSession(id)) throw conflict('profile.alreadyOpen');
    const worker = this.requireWorker();
    const sessionId = uuidv7();
    const ts = this.d.now().toISOString();
    this.d.db
      .prepare(
        `INSERT INTO browser_sessions (id, browser_profile_id, control_mode, status, started_at)
         VALUES (?, ?, ?, 'opening', ?)`,
      )
      .run(sessionId, id, controlMode, ts);
    this.d.changed(['browser']);
    try {
      const opened = await worker.request(
        'profile.open',
        { profileId: id, sessionId, channel: row.browser_channel, startUrl, controlMode },
        { timeoutMs: OPEN_TIMEOUT_MS, correlationId },
      );
      transaction(this.d.db, () => {
        const now = this.d.now().toISOString();
        this.d.db
          .prepare(
            `UPDATE browser_sessions SET status = 'open', current_url = ?, heartbeat_at = ? WHERE id = ?`,
          )
          .run(opened.currentUrl, now, sessionId);
        this.d.db
          .prepare(
            `UPDATE browser_profiles SET status = 'open', last_opened_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(now, now, id);
      });
    } catch (error) {
      this.endSession(sessionId, 'closed');
      throw error;
    } finally {
      this.d.changed(['browser', 'activity']);
    }
    return sessionId;
  }

  /** Changes who drives a session, in the worker first (it enforces it), then in the record. */
  async setControlMode(sessionId: string, controlMode: ControlMode): Promise<void> {
    await this.requireWorker().request('session.setMode', { sessionId, controlMode });
    this.d.db
      .prepare('UPDATE browser_sessions SET control_mode = ? WHERE id = ?')
      .run(controlMode, sessionId);
    this.d.changed(['browser']);
  }

  async closeSession(sessionId: string): Promise<void> {
    const worker = this.d.worker();
    if (worker) await worker.request('profile.close', { sessionId });
    this.endSession(sessionId, 'closed');
    this.d.changed(['browser']);
  }

  async focusSession(sessionId: string): Promise<void> {
    await this.requireWorker().request('session.focus', { sessionId });
  }

  sessionById(
    sessionId: string,
  ): { id: string; profileId: string; controlMode: ControlMode; status: SessionStatus } | null {
    const s = this.session(sessionId);
    return s
      ? { id: s.id, profileId: s.browser_profile_id, controlMode: s.control_mode, status: s.status }
      : null;
  }

  liveSessionOf(profileId: string): { id: string; controlMode: ControlMode } | null {
    const s = this.liveSession(profileId);
    return s ? { id: s.id, controlMode: s.control_mode } : null;
  }

  /** Told when a session ends for any reason (closed window, worker gone), e.g. to end its tasks. */
  onSessionEnded: (sessionId: string) => void = () => {};

  async close(id: string, ctx: CommandContext): Promise<BrowserProfile> {
    const session = this.liveSession(id);
    if (!session) return this.get(id);
    await this.requireWorker().request(
      'profile.close',
      { sessionId: session.id },
      { correlationId: ctx.correlationId },
    );
    // The worker also reports it; ending it here makes the answer current.
    this.endSession(session.id, 'closed');
    this.record('profile.closed', id, ctx);
    this.d.changed(['browser', 'activity']);
    return this.get(id);
  }

  async focus(id: string): Promise<void> {
    const session = this.liveSession(id);
    if (!session) throw conflict('profile.notOpen');
    await this.requireWorker().request('session.focus', { sessionId: session.id });
  }

  /** Directory writable and not locked by another Chrome (docs/08 "Health check"). */
  async check(id: string): Promise<BrowserProfile> {
    this.row(id);
    const health = await this.requireWorker().request('profile.healthCheck', { profileId: id });
    this.storeHealth(id, health.status, health.detail);
    return this.get(id);
  }

  // Worker events -------------------------------------------------------------------------------

  onSessionChanged(change: SessionChanged): void {
    if (change.status === 'open') return;
    const session = this.session(change.sessionId);
    if (!session || session.status === 'closed' || session.status === 'interrupted') return;
    this.endSession(change.sessionId, change.status === 'crashed' ? 'interrupted' : 'closed');
    this.d.audit.record({
      actorType: 'browser_worker',
      actionType: change.status === 'crashed' ? 'session.interrupted' : 'profile.closed',
      objectType: 'browser_profile',
      objectId: change.profileId,
      correlationId: uuidv7(),
    });
    this.d.changed(['browser', 'activity']);
  }

  /** The worker's live sessions; any other session core thinks is live is over. */
  onHeartbeat(sessions: { sessionId: string; currentUrl: string | null }[]): void {
    const now = this.d.now();
    const alive = new Map(sessions.map((s) => [s.sessionId, s.currentUrl]));
    let changed = false;
    transaction(this.d.db, () => {
      const live = this.d.db
        .prepare(`SELECT * FROM browser_sessions WHERE status IN ('opening', 'open')`)
        .all() as unknown as SessionRow[];
      for (const s of live) {
        if (alive.has(s.id)) {
          this.d.db
            .prepare(
              `UPDATE browser_sessions SET status = 'open', current_url = ?, heartbeat_at = ? WHERE id = ?`,
            )
            .run(alive.get(s.id) ?? null, now.toISOString(), s.id);
        } else if (s.status === 'open' || now.getTime() - Date.parse(s.started_at) > OPENING_GRACE_MS) {
          this.interrupt(s);
          changed = true;
        }
      }
    });
    if (changed) this.d.changed(['browser', 'activity']);
  }

  /** The worker is gone (crash or restart): its Chrome windows are gone with it. */
  onWorkerDetached(): void {
    let changed = false;
    transaction(this.d.db, () => {
      const live = this.d.db
        .prepare(`SELECT * FROM browser_sessions WHERE status IN ('opening', 'open')`)
        .all() as unknown as SessionRow[];
      for (const s of live) {
        this.interrupt(s);
        changed = true;
      }
    });
    if (changed) this.d.changed(['browser', 'activity']);
  }

  // ------------------------------------------------------------------------------------------------

  private interrupt(s: SessionRow): void {
    this.endSession(s.id, 'interrupted');
    this.d.audit.record({
      actorType: 'system',
      actionType: 'session.interrupted',
      objectType: 'browser_profile',
      objectId: s.browser_profile_id,
      correlationId: uuidv7(),
    });
  }

  private endSession(sessionId: string, status: 'closed' | 'interrupted'): void {
    const ts = this.d.now().toISOString();
    transaction(this.d.db, () => {
      const s = this.session(sessionId);
      if (!s) return;
      this.d.db
        .prepare(
          `UPDATE browser_sessions SET status = ?, ended_at = ? WHERE id = ? AND status IN ('opening', 'open')`,
        )
        .run(status, ts, sessionId);
      this.d.db
        .prepare(
          `UPDATE browser_profiles SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'open'`,
        )
        .run(ts, s.browser_profile_id);
    });
    this.onSessionEnded(sessionId);
  }

  storeHealth(id: string, status: ProfileHealthStatus, detail: string | null): void {
    const ts = this.d.now().toISOString();
    this.d.db
      .prepare(
        `UPDATE browser_profiles SET health = ?, last_health_check_at = ?, updated_at = ?,
           status = CASE WHEN status IN ('archived', 'open') THEN status
                         WHEN ? = 'unhealthy' THEN 'unhealthy'
                         WHEN ? = 'needs_login' THEN 'needs_login' ELSE 'ready' END
         WHERE id = ?`,
      )
      .run(JSON.stringify({ status, detail, checkedAt: ts }), ts, ts, status, status, id);
    this.d.changed(['browser']);
  }

  private setStatus(id: string, status: ProfileStatus): void {
    this.d.db
      .prepare('UPDATE browser_profiles SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, this.d.now().toISOString(), id);
  }

  private liveSession(profileId: string): SessionRow | undefined {
    return this.d.db
      .prepare(
        `SELECT * FROM browser_sessions WHERE browser_profile_id = ? AND status IN ('opening', 'open')
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(profileId) as SessionRow | undefined;
  }

  private session(id: string): SessionRow | undefined {
    return this.d.db.prepare('SELECT * FROM browser_sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  private row(id: string): ProfileRow {
    const row = this.d.db.prepare('SELECT * FROM browser_profiles WHERE id = ?').get(id) as
      ProfileRow | undefined;
    if (!row) throw new RpcError('NOT_FOUND', 'Profile not found', 'profile.notFound');
    return row;
  }

  private requireWorker(): Worker {
    const worker = this.d.worker();
    if (!worker) throw new RpcError('UNAVAILABLE', 'Browser worker is not running', 'worker.notRunning');
    return worker;
  }

  private record(
    actionType:
      | 'profile.created'
      | 'profile.updated'
      | 'profile.archived'
      | 'profile.deleted'
      | 'profile.opened'
      | 'profile.closed',
    id: string,
    ctx: CommandContext,
    payload: Record<string, unknown> = {},
  ): void {
    this.d.audit.record({
      actorType: 'user',
      actionType,
      objectType: 'browser_profile',
      objectId: id,
      payload,
      correlationId: ctx.correlationId,
    });
    this.d.changed(['browser', 'activity']);
  }

  private dto(r: ProfileRow): BrowserProfile {
    const s = this.liveSession(r.id);
    return {
      id: r.id,
      name: r.name,
      purpose: r.purpose,
      status: r.status,
      browserChannel: r.browser_channel,
      session: s
        ? {
            id: s.id,
            controlMode: s.control_mode,
            status: s.status,
            currentUrl: s.current_url,
            startedAt: s.started_at,
            heartbeatAt: s.heartbeat_at,
          }
        : null,
      health: r.health ? (JSON.parse(r.health) as BrowserProfile['health']) : null,
      lastOpenedAt: r.last_opened_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

const conflict = (detail: string) => new RpcError('CONFLICT', 'Not possible in the current state', detail);
