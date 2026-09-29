import {
  RpcError,
  RpcPeer,
  type Logger,
  type MessageEndpoint,
  type TaskResult,
  type WorkerHealth,
} from '@tabreach/protocol';
import { version as playwrightVersion } from 'playwright-core/package.json';
import { detectChrome } from './chrome.js';
import { launchCheck, type LaunchCheckOptions } from './launch-check.js';
import type { ProfileManager } from './profiles.js';
import { prepareForm, submitForm } from './forms.js';
import { renderForResearch, type RenderEnvironment } from './render.js';
import {
  ASSISTED_WAIT_MS,
  bundledPacks,
  pruneDiagnostics,
  runCheckState,
  runCommit,
  type TaskEnvironment,
} from './tasks.js';

const HEARTBEAT_MS = 10_000;
const TASK_TIMEOUT_MS = 120_000;
const RENDER_TIMEOUT_MS = 60_000;

const cancelled = (): TaskResult => ({ ...controlTaken(), errorKey: 'task.cancelled' });

const controlTaken = (): TaskResult => ({
  status: 'failed',
  stateId: null,
  stateKind: null,
  packVersion: 'unknown',
  url: null,
  diagnostics: null,
  errorKey: 'task.controlTaken',
  committed: false,
});

export interface WorkerOptions {
  /** Channel to core, provided by the host adapter (ADR 012). */
  core: MessageEndpoint;
  logger: Logger;
  /** Running profiles; shared across core connections so Chrome windows survive a core restart. */
  profiles?: ProfileManager;
  /** How often the worker tells core which sessions are alive. */
  heartbeatMs?: number;
  /** Diagnostics folder and packs for browser tasks. */
  tasks?: Partial<TaskEnvironment>;
  /** Address rules for research rendering; tests allow the loopback fixture server. */
  render?: Omit<RenderEnvironment, 'generic'>;
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
        })
        .handle('session.setMode', ({ sessionId, controlMode }) => {
          profiles.setMode(sessionId, controlMode);
          return { ok: true as const };
        })
        .handle('session.setOverlay', ({ sessionId, context }) => {
          profiles.setOverlayContext(sessionId, context);
          return { ok: true as const };
        })
        .handle('worker.emergencyStop', () => {
          profiles.emergencyStop();
          return { ok: true as const };
        })
        .handle('task.render', async (req) => {
          const context = profiles.automationContext(req.sessionId);
          const task = profiles.beginTask(req.sessionId, req.taskId);
          try {
            return await renderForResearch(
              context,
              req,
              { generic: this.taskEnv.pack('generic'), ...this.options.render },
              AbortSignal.any([task.signal, AbortSignal.timeout(RENDER_TIMEOUT_MS)]),
            );
          } finally {
            task.end();
          }
        })
        .handle('form.prepare', async (req) => {
          const context = profiles.automationContext(req.sessionId);
          const task = profiles.beginTask(req.sessionId, req.taskId);
          try {
            const page = context.pages()[0] ?? (await context.newPage());
            return await prepareForm(
              page,
              req,
              this.taskEnv,
              AbortSignal.any([task.signal, AbortSignal.timeout(TASK_TIMEOUT_MS)]),
            );
          } finally {
            task.end();
          }
        })
        .handle('form.submit', async (req) => {
          const context = profiles.automationContext(req.sessionId);
          const task = profiles.beginTask(req.sessionId, req.taskId);
          const timeoutMs = TASK_TIMEOUT_MS + (req.mode === 'assisted' ? ASSISTED_WAIT_MS : 0);
          const signal = AbortSignal.any([task.signal, AbortSignal.timeout(timeoutMs)]);
          try {
            const page = context.pages()[0] ?? (await context.newPage());
            return await submitForm(page, req, this.taskEnv, signal, () =>
              this.checkpoint(req.taskId, signal),
            );
          } catch (error) {
            // Stopped before the checkpoint (a submit past it reports that itself): nothing sent.
            if (task.signal.aborted) {
              return profiles.modeOf(req.sessionId) === 'automation' ? cancelled() : controlTaken();
            }
            throw error;
          } finally {
            task.end();
          }
        })
        .handle('task.cancel', ({ taskId }) => {
          profiles.cancelTask(taskId);
          return { ok: true as const };
        })
        .handle('task.run', async (req) => {
          const context = profiles.automationContext(req.sessionId);
          const task = profiles.beginTask(req.sessionId, req.taskId);
          const timeoutMs = TASK_TIMEOUT_MS + (req.mode === 'assisted' ? ASSISTED_WAIT_MS : 0);
          const signal = AbortSignal.any([task.signal, AbortSignal.timeout(timeoutMs)]);
          let result: TaskResult;
          try {
            const page = context.pages()[0] ?? (await context.newPage());
            result =
              req.taskType === 'commit'
                ? await runCommit(page, req, this.taskEnv, signal, () => this.checkpoint(req.taskId, signal))
                : await runCheckState(page, req, this.taskEnv, signal);
          } catch (error) {
            // The person took control, paused it, an emergency stop, or core cancelled it: the task
            // stops here (a commit task past its checkpoint reports that itself).
            if (task.signal.aborted) {
              return profiles.modeOf(req.sessionId) === 'automation' ? cancelled() : controlTaken();
            }
            throw error;
          } finally {
            task.end();
          }
          // A challenge stops automation at once; core records why and asks the person (docs/11).
          if (result.status === 'needs_human') profiles.setMode(req.sessionId, 'paused', 'challenge');
          return result;
        });
      profiles.notify = (change) => this.peer.emit('session.changed', change);
      profiles.notifyMode = (change) => this.peer.emit('session.modeChanged', change);
      const beat = () => this.peer.emit('worker.heartbeat', { sessions: profiles.heartbeat() });
      beat(); // at once: a new core learns about windows that stayed open
      void pruneDiagnostics(this.taskEnv.diagnosticsDir).then(
        (removed) =>
          removed > 0 && log.info({ event: 'diagnostics.pruned', removed }, 'old diagnostics removed'),
        (error: unknown) => log.warn({ event: 'diagnostics.prune_failed', err: error }, 'could not prune'),
      );
      this.heartbeat = setInterval(beat, options.heartbeatMs ?? HEARTBEAT_MS);
    }
  }

  private readonly heartbeat: ReturnType<typeof setInterval> | null = null;

  private get taskEnv(): TaskEnvironment {
    return {
      diagnosticsDir: this.options.tasks?.diagnosticsDir ?? 'diagnostics',
      pack: this.options.tasks?.pack ?? bundledPacks,
    };
  }

  /**
   * Waits for core to record the checkpoint (docs/07). No answer means no press: a core that cannot
   * record "executing" must not have the action happen behind its back.
   */
  private async checkpoint(taskId: string, signal: AbortSignal): Promise<boolean> {
    try {
      const ack = await this.peer.request(
        'task.checkpoint',
        { taskId, phase: 'about_to_commit' },
        { timeoutMs: 30_000 },
      );
      return ack.proceed && !signal.aborted;
    } catch (error) {
      this.options.logger.warn({ event: 'task.checkpoint_failed', taskId, err: error }, 'no checkpoint ack');
      return false;
    }
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
        throw new RpcError('BROWSER_CHROME_NOT_FOUND', 'Google Chrome is not installed', 'chrome.missing');
      }
    }
    return launchCheck(url, { ...this.options.launch, logger: this.options.logger });
  }
}
