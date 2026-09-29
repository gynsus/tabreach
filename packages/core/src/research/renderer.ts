import type { DatabaseSync } from 'node:sqlite';
import { RpcError, uuidv7, type Logger, type RenderResult, type RpcPeer } from '@tabreach/protocol';
import type { BrowserService } from '../browser/browser-service.js';

/** The research window closes after this long without a page to render. */
const IDLE_CLOSE_MS = 60_000;
const RENDER_TIMEOUT_MS = 75_000;

/**
 * RenderPageForResearch from core's side (docs/16, docs/08, Phase 5d). Pages are rendered in the
 * research profile — created on first use, never a channel identity — one at a time, without a
 * window. When the person holds that profile's window, or the worker is not running, nothing is
 * rendered and research keeps what the static fetch found.
 */
export class ResearchRenderer {
  private chain: Promise<unknown> = Promise.resolve();
  private idle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly d: {
      db: DatabaseSync;
      browser: BrowserService;
      worker: () => Pick<RpcPeer, 'request'> | null;
      logger: Logger;
    },
  ) {}

  /** null: rendering is not available right now (no worker, the person holds the window). */
  render(url: string, site: string, signal: AbortSignal): Promise<RenderResult | null> {
    const next = this.chain.then(() => this.renderNow(url, site, signal));
    this.chain = next.catch(() => {});
    return next;
  }

  /** Closes the research window now (the app quits, tests). */
  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const profileId = this.profileId(false);
    const live = profileId ? this.d.browser.liveSessionOf(profileId) : null;
    if (live && live.controlMode === 'automation') await this.d.browser.closeSession(live.id).catch(() => {});
  }

  private async renderNow(url: string, site: string, signal: AbortSignal): Promise<RenderResult | null> {
    signal.throwIfAborted();
    const worker = this.d.worker();
    if (!worker) return null;
    if (this.idle) clearTimeout(this.idle);
    const profileId = this.profileId(true) as string;
    try {
      const session = this.d.browser.liveSessionOf(profileId);
      // The person opened it: it is theirs until they close it (docs/11).
      if (session && session.controlMode !== 'automation') return null;
      const sessionId =
        session?.id ??
        (await this.d.browser.openSession(profileId, 'automation', null, uuidv7(), { headless: true }));
      return await worker.request(
        'task.render',
        { taskId: uuidv7(), sessionId, url, site },
        { timeoutMs: RENDER_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof RpcError) {
        this.d.logger.info(
          { event: 'research.render_unavailable', detail: error.problem.detail },
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
