import type { Problem } from './envelope.js';
import type { EventPayloadOf, EventsOn } from './events.js';
import type { RequestOf, RequestsOn, ResponseOf } from './messages.js';

/** Result shape crossing Electron's contextBridge (Error subclasses do not survive it). */
export type BridgeResult<T> = { ok: true; data: T } | { ok: false; error: Problem };

/** API the preload exposes to the renderer as `window.tabreach`. Only the app channel is reachable. */
export interface SaveFileRequest {
  suggestedName: string;
  content: string;
}
export type SaveFileResult = { saved: true; path: string } | { saved: false };

/** Lifecycle of the core process as main sees it (ADR 020). */
export type CoreState = 'starting' | 'running' | 'restarting' | 'failed';

export interface InvokeOptions {
  /** Reuse the same key when retrying the same user action; core then runs it only once. */
  idempotencyKey?: string;
}

export interface TabReachBridge {
  invoke<T extends RequestsOn<'app'>>(
    type: T,
    payload: RequestOf<T>,
    options?: InvokeOptions,
  ): Promise<BridgeResult<ResponseOf<T>>>;
  /** Subscribes to core events; survives core restarts and page reloads. Returns unsubscribe. */
  subscribe<T extends EventsOn<'app'>>(type: T, listener: (payload: EventPayloadOf<T>) => void): () => void;
  /** Core process state changes (and the current state immediately). Returns unsubscribe. */
  onCoreState(listener: (state: CoreState) => void): () => void;
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
  // SMTP and IMAP checks take up to 30 s each.
  'accounts.connectImap': 90_000,
  'accounts.update': 90_000,
  'accounts.test': 90_000,
  // The user signs in to Google in the browser.
  'accounts.connectGmail': 11 * 60_000,
  'ai.testKey': 90_000,
};
