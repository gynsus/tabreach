import { MessageChannelMain, type UtilityProcess } from 'electron';
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

export interface SelfCheckReport {
  ok: boolean;
  health: HealthReport | null;
  launch: LaunchCheckResult | null;
  error?: string;
}

export async function runSelfCheck(
  coreProc: UtilityProcess,
  url: string | null,
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
    return { ok: componentsOk && (launch?.ok ?? true), health, launch };
  } catch (error) {
    const message = error instanceof RpcError ? error.message : 'Unexpected error';
    logger.error({ event: 'self_check.failed', err: error }, 'self-check failed');
    return { ok: false, health: null, launch: null, error: message };
  } finally {
    peer.close();
    port2.close();
  }
}
