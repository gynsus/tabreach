import { RpcError, RpcPeer, type Logger, type MessageEndpoint, type WorkerHealth } from '@tabreach/protocol';
import { version as playwrightVersion } from 'playwright-core/package.json';
import { detectChrome } from './chrome.js';
import { launchCheck, type LaunchCheckOptions } from './launch-check.js';
import type { ProfileManager } from './profiles.js';

const HEARTBEAT_MS = 10_000;

export interface WorkerOptions {
  /** Channel to core, provided by the host adapter (ADR 012). */
  core: MessageEndpoint;
  logger: Logger;
  /** Running profiles; shared across core connections so Chrome windows survive a core restart. */
  profiles?: ProfileManager;
  /** How often the worker tells core which sessions are alive. */
  heartbeatMs?: number;
  /** Overrides for tests: fixture Chrome locations, headless mode, Chromium. */
  chromeLocations?: string[];
  launch?: Omit<LaunchCheckOptions, 'logger'>;
}

/**
 * Browser worker service. Holds no durable state; everything it learns goes back to core.
 */
export class BrowserWorker {
  private readonly peer: RpcPeer;

  constructor(private readonly options: WorkerOptions) {
    const log = options.logger.child({ channel: 'browser' });
    this.peer = new RpcPeer(options.core, {
      onInvalid: (reason) => log.warn({ event: 'ipc.invalid_message', reason }, 'dropped message'),
      onHandlerError: (type, err) => log.error({ event: 'ipc.handler_failed', type, err }, 'handler failed'),
    })
      .handle('worker.health', () => this.health())
      .handle('worker.launchCheck', ({ url }) => this.launchCheck(url));
    const profiles = options.profiles;
    if (profiles) {
      this.peer
        .handle('profile.open', async (req) => {
          if (req.channel === 'chrome') await this.requireChrome();
          return profiles.open(req);
        })
        .handle('profile.close', async ({ sessionId }) => {
          await profiles.close(sessionId);
          return { ok: true as const };
        })
        .handle('profile.healthCheck', ({ profileId }) => profiles.health(profileId))
        .handle('profile.delete', async ({ profileId }) => {
          await profiles.delete(profileId);
          return { ok: true as const };
        })
        .handle('session.focus', async ({ sessionId }) => {
          await profiles.focus(sessionId);
          return { ok: true as const };
        });
      profiles.notify = (change) => this.peer.emit('session.changed', change);
      const beat = () => this.peer.emit('worker.heartbeat', { sessions: profiles.heartbeat() });
      beat(); // at once: a new core learns about windows that stayed open
      this.heartbeat = setInterval(beat, options.heartbeatMs ?? HEARTBEAT_MS);
    }
  }

  private readonly heartbeat: ReturnType<typeof setInterval> | null = null;

  async health(): Promise<WorkerHealth> {
    const chrome = await detectChrome(this.options.chromeLocations);
    return {
      status: chrome.installed ? 'ok' : 'degraded',
      node: process.versions.node,
      playwright: playwrightVersion,
      chrome,
    };
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.peer.close();
  }

  private async requireChrome(): Promise<void> {
    const chrome = await detectChrome(this.options.chromeLocations);
    if (!chrome.installed)
      throw new RpcError('BROWSER_CHROME_NOT_FOUND', 'Google Chrome is not installed', 'chrome.missing');
  }

  private async launchCheck(url: string) {
    const channel = this.options.launch?.channel ?? 'chrome';
    if (channel === 'chrome') {
      const chrome = await detectChrome(this.options.chromeLocations);
      if (!chrome.installed) {
        throw new RpcError(
          'BROWSER_CHROME_NOT_FOUND',
          'Google Chrome is not installed',
          'Install Google Chrome and try again.',
        );
      }
    }
    return launchCheck(url, { ...this.options.launch, logger: this.options.logger });
  }
}
