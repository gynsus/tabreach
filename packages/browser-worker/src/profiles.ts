import { existsSync } from 'node:fs';
import { access, lstat, mkdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import {
  OVERLAY_BINDING,
  OVERLAY_SCRIPT,
  PAUSE_REQUESTED,
  overlayContextFor,
  overlaySetExpression,
} from './overlay.js';
import {
  RpcError,
  type ControlMode,
  type Logger,
  type OverlayContext,
  type SessionModeChanged,
  type SessionChanged,
  type WorkerProfileHealth,
} from '@tabreach/protocol';

/**
 * Playwright's defaults are made for tests. In a profile the user signs in to real accounts with,
 * these would weaken Chrome (ADR 026): no sandbox, no Safe Browsing or security component updates,
 * no phishing detection, no popup blocking, cookies encrypted with a fixed key instead of the Keychain.
 */
const TEST_ONLY_DEFAULTS = [
  '--disable-background-networking',
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-hang-monitor',
  '--disable-default-apps',
];
const KEYCHAIN_DEFAULTS = ['--use-mock-keychain', '--password-store=basic'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Session {
  profileId: string;
  context: BrowserContext;
  closing: boolean;
  /** docs/11: automation may act only in `automation`; the worker enforces it. */
  controlMode: ControlMode;
  /** Aborted whenever the session leaves automation: the running task stops at its next step. */
  abort: AbortController;
  /** Sessions opened for automation carry the in-page overlay (docs/12). */
  overlay: boolean;
  overlayContext: OverlayContext | null;
  /** The task running in this session: one at a time (audit 5.5). */
  task: { id: string; abort: AbortController } | null;
  /** An unknown overlay message was logged once; a page cannot flood the log. */
  ignoredLogged: boolean;
  /** A page of this session crashed (Chrome's own report). */
  crashed: boolean;
}

export interface ProfileManagerOptions {
  /** `<app data>/profiles`; each profile is `<root>/<profile id>` (docs/08). */
  root: string;
  /**
   * Visible by default: the person sees every window that acts (docs/11). Only research renders
   * headless (ADR 027), per `open`; this switch makes every window headless, for tests.
   */
  headless?: boolean;
  /**
   * Profiles encrypt cookies and saved data with the macOS Keychain, like the user's own Chrome
   * (ADR 026). Tests turn it off: a CI runner cannot answer a Keychain prompt.
   */
  keychain?: boolean;
  logger: Logger;
}

/**
 * The worker's running profiles (docs/07, docs/08). It outlives a core connection: when core
 * restarts, the Chrome windows stay open and the next heartbeat tells the new core about them.
 * Chrome's own profile lock keeps a directory to one browser at a time.
 */
/**
 * A URL as it may be stored (audit 5.5): origin and path only. Query strings and fragments carry
 * reset links, sign-in codes and session ids of whatever the person is browsing.
 */
export function safeUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}` : `${u.protocol}`;
  } catch {
    return null;
  }
}

export class ProfileManager {
  private readonly sessions = new Map<string, Session>();
  /** Where session changes go; set by the current core connection. */
  notify: (change: SessionChanged) => void = () => {};
  /** Control-mode changes made on the worker's side (overlay Pause, challenge, emergency stop). */
  notifyMode: (change: SessionModeChanged) => void = () => {};

  constructor(private readonly options: ProfileManagerOptions) {}

  dir(profileId: string): string {
    // The id becomes a path: only a UUID, never anything that could leave the profiles root.
    if (!UUID.test(profileId))
      throw new RpcError('VALIDATION_FAILED', 'Invalid profile id', 'profile.invalidId');
    return join(this.options.root, profileId);
  }

  async open(req: {
    profileId: string;
    sessionId: string;
    channel: 'chrome' | 'chromium';
    startUrl: string | null;
    controlMode?: ControlMode;
    headless?: boolean;
  }): Promise<{ chromeVersion: string | null; currentUrl: string | null }> {
    if (this.sessionOf(req.profileId))
      throw new RpcError('CONFLICT', 'Profile already open', 'profile.alreadyOpen');
    const dir = this.dir(req.profileId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(dir, {
        ...(req.channel === 'chrome' ? { channel: 'chrome' } : {}),
        headless: (req.headless ?? false) || (this.options.headless ?? false),
        // A research page cannot install a worker that outlives it or escapes the page's routes.
        // Research (ADR 027): no downloads, and WebRTC cannot reach around the request guard.
        ...(req.headless
          ? {
              serviceWorkers: 'block' as const,
              acceptDownloads: false,
              args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
            }
          : {}),
        // Chrome's sandbox stays on (Playwright turns it off by default).
        chromiumSandbox: true,
        ignoreDefaultArgs: [
          ...TEST_ONLY_DEFAULTS,
          ...(this.options.keychain === false ? [] : KEYCHAIN_DEFAULTS),
        ],
        // The window keeps its own size, like a normal browser window.
        viewport: req.headless ? { width: 1280, height: 900 } : null,
        timeout: 60_000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ProcessSingleton|already in use|profile.*lock/i.test(message)) {
        throw new RpcError('CONFLICT', 'Profile in use', 'profile.inUse');
      }
      this.options.logger.warn(
        { event: 'profile.open_failed', profileId: req.profileId, err: error },
        'could not open profile',
      );
      throw new RpcError('BROWSER_LAUNCH_FAILED', 'Chrome could not open the profile', 'profile.openFailed');
    }
    const session: Session = {
      profileId: req.profileId,
      context,
      closing: false,
      controlMode: req.controlMode ?? 'human',
      abort: new AbortController(),
      overlay: req.controlMode === 'automation' && !req.headless,
      overlayContext: null,
      task: null,
      ignoredLogged: false,
      crashed: false,
    };
    this.sessions.set(req.sessionId, session);
    if (session.overlay) await this.installOverlay(req.sessionId, session);
    context.on('close', () => {
      if (!this.sessions.delete(req.sessionId)) return;
      // Crashed only when Chrome said a page crashed; closing windows or quitting Chrome is a close.
      const status = session.crashed ? 'crashed' : 'closed';
      this.notify({ sessionId: req.sessionId, profileId: req.profileId, status, currentUrl: null });
    });
    const onCrash = (page: Page) => page.on('crash', () => (session.crashed = true));
    context.on('page', onCrash);
    for (const page of context.pages()) onCrash(page);
    // On macOS Chrome keeps running without windows; the last window closed ends the session.
    context.on('page', (page) =>
      page.on('close', () => {
        if (context.pages().length === 0 && !session.closing) void this.close(req.sessionId);
      }),
    );
    for (const page of context.pages())
      page.on('close', () => {
        if (context.pages().length === 0 && !session.closing) void this.close(req.sessionId);
      });
    const page = context.pages()[0] ?? (await context.newPage());
    if (req.startUrl) {
      await page
        .goto(req.startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        .catch((error: unknown) => {
          // The window is open either way; a slow or failing first page is the user's to see.
          this.options.logger.info(
            { event: 'profile.start_url_failed', err: error },
            'start page did not load',
          );
        });
    }
    return { chromeVersion: context.browser()?.version() ?? null, currentUrl: page.url() };
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing) return;
    session.closing = true;
    await session.context.close();
  }

  async focus(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new RpcError('NOT_FOUND', 'Session not open', 'session.notOpen');
    const page = session.context.pages()[0] ?? (await session.context.newPage());
    await page.bringToFront();
  }

  /** Directory present and writable, and not locked by a Chrome this worker does not own. */
  async health(profileId: string): Promise<WorkerProfileHealth> {
    const dir = this.dir(profileId);
    if (this.sessionOf(profileId)) return { status: 'busy', detail: 'profile.open' };
    if (!existsSync(dir)) return { status: 'healthy', detail: 'profile.new' };
    try {
      await access(dir, constants.R_OK | constants.W_OK);
    } catch {
      return { status: 'unhealthy', detail: 'profile.notWritable' };
    }
    const lock = await lstat(join(dir, 'SingletonLock')).catch(() => null);
    if (lock) return { status: 'busy', detail: 'profile.inUse' };
    return { status: 'healthy', detail: null };
  }

  async delete(profileId: string): Promise<void> {
    if (this.sessionOf(profileId)) throw new RpcError('CONFLICT', 'Profile is open', 'profile.open');
    // Chrome may still be flushing files for a moment after its window closed.
    await rm(this.dir(profileId), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  /**
   * Changes who drives a session. Leaving automation aborts the running task at its next step.
   * `by` is set when the change starts in the worker (it is reported to core).
   */
  setMode(sessionId: string, mode: ControlMode, by?: SessionModeChanged['by']): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new RpcError('NOT_FOUND', 'Session not open', 'session.notOpen');
    const changed = session.controlMode !== mode;
    session.controlMode = mode;
    if (mode !== 'automation') {
      session.abort.abort(new Error('control_changed'));
      session.abort = new AbortController();
    }
    this.applyOverlay(session);
    if (by && changed) this.notifyMode({ sessionId, controlMode: mode, by });
  }

  /**
   * Starts the one task a session may run (audit 5.5): a second one — say from a core that
   * restarted while the first still runs — is refused. The signal ends with the task, when the
   * session leaves automation, or when core cancels it (`task.cancel`).
   */
  beginTask(sessionId: string, taskId: string): { signal: AbortSignal; end: () => void } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new RpcError('NOT_FOUND', 'Session not open', 'session.notOpen');
    if (session.task) throw new RpcError('CONFLICT', 'A task is running in this session', 'session.busy');
    const abort = new AbortController();
    const task = { id: taskId, abort };
    session.task = task;
    return {
      signal: AbortSignal.any([abort.signal, session.abort.signal]),
      end: () => {
        if (session.task === task) session.task = null;
      },
    };
  }

  modeOf(sessionId: string): ControlMode | null {
    return this.sessions.get(sessionId)?.controlMode ?? null;
  }

  cancelTask(taskId: string): boolean {
    for (const s of this.sessions.values()) {
      if (s.task?.id === taskId) {
        s.task.abort.abort(new Error('cancelled'));
        return true;
      }
    }
    return false;
  }

  /** Aborted when the session leaves automation (take control, pause, emergency stop). */
  taskSignal(sessionId: string): AbortSignal {
    const session = this.sessions.get(sessionId);
    if (!session) throw new RpcError('NOT_FOUND', 'Session not open', 'session.notOpen');
    return session.abort.signal;
  }

  setOverlayContext(sessionId: string, context: OverlayContext | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new RpcError('NOT_FOUND', 'Session not open', 'session.notOpen');
    session.overlayContext = context;
    this.applyOverlay(session);
  }

  /** docs/19: every session paused and every task stopped, at once. */
  emergencyStop(): void {
    for (const [sessionId, s] of this.sessions) {
      if (s.controlMode === 'automation') this.setMode(sessionId, 'paused', 'emergency_stop');
    }
  }

  private async installOverlay(sessionId: string, session: Session): Promise<void> {
    // The page can call this binding: it accepts one message, and that one only pauses (docs/12).
    await session.context.exposeBinding(OVERLAY_BINDING, (_source, message: unknown) => {
      if (message === PAUSE_REQUESTED && session.controlMode === 'automation') {
        this.setMode(sessionId, 'paused', 'overlay');
      } else if (message !== PAUSE_REQUESTED && !session.ignoredLogged) {
        session.ignoredLogged = true;
        this.options.logger.warn(
          { event: 'overlay.ignored_message', sessionId },
          'page sent an unknown overlay message',
        );
      }
    });
    await session.context.addInitScript(OVERLAY_SCRIPT);
    const watch = (page: Page) => page.on('domcontentloaded', () => this.applyOverlay(session));
    session.context.on('page', watch);
    for (const page of session.context.pages()) {
      watch(page);
      // The overlay is explanatory (docs/12): a page mid-navigation gets it on its next load.
      await page.evaluate(OVERLAY_SCRIPT).catch(() => {});
    }
    this.applyOverlay(session);
  }

  private applyOverlay(session: Session): void {
    if (!session.overlay) return;
    const context = session.overlayContext;
    // Explanatory only; a page mid-navigation is updated on its domcontentloaded.
    for (const page of session.context.pages()) {
      const shown = overlayContextFor(context, page.url());
      void page.evaluate(overlaySetExpression({ mode: session.controlMode, context: shown })).catch(() => {});
    }
  }

  /**
   * The browser a task may drive: only a session under automation. A person holding control (or a
   * pause) rejects every task action (docs/11 "Control rules").
   */
  automationContext(sessionId: string): BrowserContext {
    const session = this.sessions.get(sessionId);
    if (!session) throw new RpcError('NOT_FOUND', 'Session not open', 'session.notOpen');
    if (session.controlMode !== 'automation')
      throw new RpcError('CONFLICT', 'Not under automation', 'session.notAutomation');
    return session.context;
  }

  /** The running browser of a session, for browser tasks (Phase 5b) and tests. */
  contextOf(sessionId: string): BrowserContext | undefined {
    return this.sessions.get(sessionId)?.context;
  }

  heartbeat(): { sessionId: string; currentUrl: string | null }[] {
    return [...this.sessions].map(([sessionId, s]) => ({
      sessionId,
      currentUrl: safeUrl(s.context.pages()[0]?.url() ?? null),
    }));
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id)));
  }

  private sessionOf(profileId: string): string | undefined {
    for (const [sessionId, s] of this.sessions) if (s.profileId === profileId) return sessionId;
    return undefined;
  }
}
