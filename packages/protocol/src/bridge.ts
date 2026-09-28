import type { Problem } from './envelope.js';
import type { RequestOf, RequestsOn, ResponseOf } from './messages.js';

/** Result shape crossing Electron's contextBridge (Error subclasses do not survive it). */
export type BridgeResult<T> = { ok: true; data: T } | { ok: false; error: Problem };

/** API the preload exposes to the renderer as `window.tabreach`. Only the app channel is reachable. */
export interface TabReachBridge {
  invoke<T extends RequestsOn<'app'>>(type: T, payload: RequestOf<T>): Promise<BridgeResult<ResponseOf<T>>>;
}

/** Per-request timeouts on the app channel; everything else uses the RpcPeer default. */
export const appRequestTimeoutsMs: Partial<Record<RequestsOn<'app'>, number>> = {
  'browser.launchCheck': 100_000,
};
