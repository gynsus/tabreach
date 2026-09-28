import type { Problem } from './envelope.js';
import type { RequestOf, RequestsOn, ResponseOf } from './messages.js';

/** Result shape crossing Electron's contextBridge (Error subclasses do not survive it). */
export type BridgeResult<T> = { ok: true; data: T } | { ok: false; error: Problem };

/** API the preload exposes to the renderer as `window.tabreach`. Only the app channel is reachable. */
export interface SaveFileRequest {
  suggestedName: string;
  content: string;
}
export type SaveFileResult = { saved: true; path: string } | { saved: false };

export interface TabReachBridge {
  invoke<T extends RequestsOn<'app'>>(type: T, payload: RequestOf<T>): Promise<BridgeResult<ResponseOf<T>>>;
  /** Asks main to show a save dialog and write text the user chose to save (exports). */
  saveTextFile(request: SaveFileRequest): Promise<SaveFileResult>;
}

/** Upper bound for text handed to main for saving. */
export const MAX_SAVE_FILE_CHARS = 50_000_000;

/** Per-request timeouts on the app channel; everything else uses the RpcPeer default. */
export const appRequestTimeoutsMs: Partial<Record<RequestsOn<'app'>, number>> = {
  'browser.launchCheck': 100_000,
  'imports.prospects.commit': 300_000,
  'imports.prospects.preview': 60_000,
  'exports.prospects': 120_000,
  'suppressions.import': 120_000,
};
