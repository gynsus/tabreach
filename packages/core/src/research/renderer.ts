import type { DatabaseSync } from 'node:sqlite';
import { RpcError, uuidv7, type Logger, type RenderResult, type RpcPeer } from '@tabreach/protocol';
import { untilAborted } from '../browser/browser-channel.js';
import type { BrowserService } from '../browser/browser-service.js';

/** The research window closes after this long without a page to render. */
const IDLE_CLOSE_MS = 60_000;
const RENDER_TIMEOUT_MS = 75_000;

/**
 * RenderPageForResearch from core's side (docs/16, docs/08, ADR 027). Pages are rendered in the
 * research profile — created on first use, never a channel identity — one at a time, without a
 * window. When the person holds that profile, the app is paused, or the worker is not running,
 * nothing is rendered and research keeps what the static fetch found.
 */
export class ResearchRenderer {
  private chain: Promise<unknown> = Promise.resolve();
  private idle: ReturnType<typeof setTimeout> | null = null;
  /** The headless session this renderer opened; nobody else can see or use it. */
  private own: string | null = null;

  constructor(
    private readonly d: {
      db: DatabaseSync;
      browser: BrowserService;
      worker: () => Pick<RpcPeer, 'request'> | null;
      logger: Logger;
      /** App-wide pause (docs/19): no browser work starts. */
      paused?: () => boolean;
    },
  ) {}

  /** null: rendering is not available right now (no worker, paused, the person holds the profile). */
  render(
    url: string,
    site: string,
    signal: AbortSignal,
    correlationId = uuidv7(),
  ): Promise<RenderResult | null> {
    return this.serial(() => this.renderNow(url, site, signal, correlationId));
  }

  /** Closes the research window (idle, app quit, tests); in line with renders, never under one. */
  close(): Promise<void> {
    return this.serial(() => this.closeNow());
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => {}); // the caller gets the error; the chain goes on
    return next;
  }

  private async closeNow(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const own = this.own;
    this.own = null;
    const session = own ? this.d.browser.sessionById(own) : null;
    if (session && (session.status === 'open' || session.status === 'opening')) {
      await this.d.browser
        .closeSession(session.id)
        .catch((error: unknown) =>
          this.d.logger.warn({ event: 'research.close_failed', err: error }, 'research window not closed'),
        );
    }
  }

  private async renderNow(
    url: string,
    site: string,
    signal: AbortSignal,
    correlationId: string,
  ): Promise<RenderResult | null> {
    signal.throwIfAborted();
    const worker = this.d.worker();
    if (!worker || this.d.paused?.()) return null;
    if (this.idle) clearTimeout(this.idle);
    const profileId = this.profileId(true) as string;
    try {
      let session = this.d.browser.liveSessionOf(profileId);
      if (session && session.id === this.own && session.controlMode !== 'automation') {
        // Ours, but paused (an emergency stop, say): nobody can act in a headless window, so it
        // is closed and opened afresh once the app runs again (audit 5.5).
        await this.closeNow();
        session = null;
      }
      // The person opened it: it is theirs until they close it (docs/11).
      if (session && session.controlMode !== 'automation') return null;
      const sessionId =
        session?.id ??
        (await this.d.browser.openSession(profileId, 'automation', null, correlationId, { headless: true }));
      this.own = sessionId;
      const taskId = uuidv7();
      return await untilAborted(
        signal,
        () =>
          void worker
            .request('task.cancel', { taskId }, { correlationId })
            .catch((error: unknown) =>
              this.d.logger.warn({ event: 'research.cancel_failed', err: error }, 'render not cancelled'),
            ),
        worker.request(
          'task.render',
          { taskId, sessionId, url, site },
          { timeoutMs: RENDER_TIMEOUT_MS, correlationId },
        ),
      );
    } catch (error) {
      if (error instanceof RpcError) {
        this.d.logger.info(
          { event: 'research.render_unavailable', detail: error.problem.detail, correlationId },
          'not rendered',
        );
        return null;
      }
      throw error;
    } finally {
      this.idle = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
      this.idle.unref?.();
    }
  }

  /** The research profile: the oldest one, or a new one when `create` (docs/08: created on first use). */
  private profileId(create: boolean): string | null {
    const row = this.d.db
      .prepare(
        `SELECT id FROM browser_profiles WHERE purpose = 'research' AND status != 'archived' ORDER BY created_at LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (row || !create) return row?.id ?? null;
    return this.d.browser.create(
      { name: 'Research', purpose: 'research' },
      { correlationId: uuidv7() },
      'system',
    ).id;
  }
}
