import { RpcError, RpcPeer, type Logger, type MessageEndpoint, type WorkerHealth } from '@tabreach/protocol';
import { version as playwrightVersion } from 'playwright-core/package.json';
import { detectChrome } from './chrome.js';
import { launchCheck, type LaunchCheckOptions } from './launch-check.js';

export interface WorkerOptions {
  /** Channel to core, provided by the host adapter (ADR 012). */
  core: MessageEndpoint;
  logger: Logger;
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
  }

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
    this.peer.close();
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
