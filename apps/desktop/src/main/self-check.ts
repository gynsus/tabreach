import { MessageChannelMain, type UtilityProcess, type WebContents } from 'electron';
import {
  RpcError,
  RpcPeer,
  type HealthReport,
  type LaunchCheckResult,
  type Logger,
} from '@tabreach/protocol';
import { portEndpoint, type PortHandoff } from '../shared/ipc';

export const SELF_CHECK_FLAG = '--self-check';
const WORKER_WAIT_MS = 20_000;

/**
 * `TabReach --self-check[=<url>]`: headless diagnostics for packaged builds (ADR 012 validation,
 * support). Talks to core over the same app protocol the UI uses, so it exercises the real path.
 */
export function parseSelfCheck(argv: readonly string[]): { enabled: boolean; url: string | null } {
  const arg = argv.find((a) => a === SELF_CHECK_FLAG || a.startsWith(`${SELF_CHECK_FLAG}=`));
  if (!arg) return { enabled: false, url: null };
  const url = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : null;
  return { enabled: true, url: url || null };
}

export interface UiCheckResult {
  ok: boolean;
  url: string;
  /** Console errors the page logged while loading (e.g. a script blocked from loading). */
  errors: string[];
}

export interface SelfCheckReport {
  ok: boolean;
  health: HealthReport | null;
  launch: LaunchCheckResult | null;
  ui: UiCheckResult | null;
  error?: string;
}

const UI_WAIT_MS = 15_000;

/**
 * The window really shows the interface: React mounted something into #root, and the page
 * reaches core through the preload bridge. Component checks alone passed while the packaged
 * window stayed blank (its script never loaded), so the release check looks at the page itself.
 */
export async function checkUi(wc: WebContents, waitMs = UI_WAIT_MS): Promise<UiCheckResult> {
  const errors: string[] = [];
  const onConsole = (details: { level: string; message: string }) => {
    if (details.level === 'error') errors.push(details.message);
  };
  wc.on('console-message', onConsole);
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const mounted = wc.isLoading()
        ? false
        : await wc.executeJavaScript('(document.getElementById("root")?.childElementCount ?? 0) > 0', true);
      if (mounted === true) {
        // And it reaches core through the real bridge, not only paints.
        const connected = await wc.executeJavaScript(
          'window.tabreach.invoke("app.health", {}).then((r) => r.ok === true)',
          true,
        );
        if (connected !== true) errors.push('the window cannot reach core');
        return { ok: connected === true, url: wc.getURL(), errors };
      }
      if (Date.now() >= deadline) return { ok: false, url: wc.getURL(), errors };
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    wc.off('console-message', onConsole);
  }
}

export async function runSelfCheck(
  coreProc: UtilityProcess,
  url: string | null,
  ui: () => Promise<UiCheckResult>,
  logger: Logger,
): Promise<SelfCheckReport> {
  const { port1, port2 } = new MessageChannelMain();
  const handoff: PortHandoff = { __tabreach: 'port', name: 'app' };
  coreProc.postMessage(handoff, [port1]);
  const peer = new RpcPeer(portEndpoint(port2));

  try {
    // The worker connects to core asynchronously; wait until core reports it.
    const deadline = Date.now() + WORKER_WAIT_MS;
    let health = await peer.request('app.health', {});
    while (!('chrome' in health.worker) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      health = await peer.request('app.health', {});
    }
    const launch = url ? await peer.request('browser.launchCheck', { url }, { timeoutMs: 100_000 }) : null;
    const componentsOk =
      health.core.status === 'ok' &&
      health.database.status === 'ok' &&
      health.secrets.status === 'ok' &&
      'chrome' in health.worker &&
      health.worker.chrome.installed;
    const uiResult = await ui();
    return { ok: componentsOk && uiResult.ok && (launch?.ok ?? true), health, launch, ui: uiResult };
  } catch (error) {
    const message = error instanceof RpcError ? error.message : 'Unexpected error';
    logger.error({ event: 'self_check.failed', err: error }, 'self-check failed');
    return { ok: false, health: null, launch: null, ui: null, error: message };
  } finally {
    peer.close();
    port2.close();
  }
}
