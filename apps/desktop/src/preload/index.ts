// Sandboxed preload: the only bridge between the renderer and core (docs/06-API-CONTRACT.md, ADR 020).
import { contextBridge, ipcRenderer } from 'electron';
import {
  RpcError,
  RpcPeer,
  appRequestTimeoutsMs,
  isEventType,
  isRequestType,
  requests,
  type CoreState,
  type EventType,
  type MessageEndpoint,
  type TabReachBridge,
} from '@tabreach/protocol';

/** How long a request waits for core to (re)connect before failing. */
const CONNECT_TIMEOUT_MS = 10_000;

let peer: RpcPeer | null = null;
let coreState: CoreState = 'starting';
let waiters: Array<{ resolve: (p: RpcPeer) => void; reject: (e: RpcError) => void }> = [];
const stateListeners = new Set<(state: CoreState) => void>();
/** Renderer subscriptions, re-attached to every new port so they survive core restarts. */
const subscriptions = new Map<EventType, Set<(payload: unknown) => void>>();

function domPortEndpoint(port: MessagePort): MessageEndpoint {
  const listeners = new Set<(m: unknown) => void>();
  port.onmessage = (event) => {
    for (const l of listeners) l(event.data);
  };
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function forward(target: RpcPeer, type: EventType): void {
  target.on(type, (payload) => {
    for (const listener of subscriptions.get(type) ?? []) listener(payload);
  });
}

// Main sends a fresh port on every page load and whenever core restarts.
ipcRenderer.on('tabreach:port', (event) => {
  const [port] = event.ports;
  if (!port) return;
  peer?.close();
  peer = new RpcPeer(domPortEndpoint(port));
  for (const type of subscriptions.keys()) forward(peer, type);
  const ready = peer;
  for (const w of waiters.splice(0)) w.resolve(ready);
});

ipcRenderer.on('tabreach:core-state', (_event, state: CoreState) => {
  coreState = state;
  if (state !== 'running') {
    // The old port is dead: fail its pending requests now instead of after their timeouts.
    peer?.close();
    peer = null;
  }
  if (state === 'failed') {
    for (const w of waiters.splice(0)) w.reject(new RpcError('UNAVAILABLE', 'Core has stopped'));
  }
  for (const listener of stateListeners) listener(state);
});

function connected(): Promise<RpcPeer> {
  if (peer) return Promise.resolve(peer);
  if (coreState === 'failed') return Promise.reject(new RpcError('UNAVAILABLE', 'Core has stopped'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== waiter);
      reject(new RpcError('UNAVAILABLE', 'Core is not running'));
    }, CONNECT_TIMEOUT_MS);
    const waiter = {
      resolve: (p: RpcPeer) => {
        clearTimeout(timer);
        resolve(p);
      },
      reject: (e: RpcError) => {
        clearTimeout(timer);
        reject(e);
      },
    };
    waiters.push(waiter);
  });
}

const bridge: TabReachBridge = {
  async invoke(type, payload, options = {}) {
    // Renderer code may only reach the app channel; host and browser messages are not addressable.
    if (!isRequestType(type) || requests[type].channel !== 'app') {
      return {
        ok: false,
        error: { code: 'UNKNOWN_MESSAGE_TYPE', title: 'Unknown message type', detail: String(type) },
      };
    }
    try {
      const timeoutMs = appRequestTimeoutsMs[type];
      const target = await connected();
      const data = await target.request(type, payload, {
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
      return { ok: true, data };
    } catch (error) {
      if (error instanceof RpcError) return { ok: false, error: error.problem };
      return { ok: false, error: { code: 'INTERNAL', title: 'Unexpected error' } };
    }
  },

  subscribe(type, listener) {
    if (!isEventType(type)) return () => {};
    let set = subscriptions.get(type);
    if (!set) {
      set = new Set();
      subscriptions.set(type, set);
      if (peer) forward(peer, type);
    }
    const entry = listener as (payload: unknown) => void;
    set.add(entry);
    return () => set.delete(entry);
  },

  onCoreState(listener) {
    stateListeners.add(listener);
    listener(coreState);
    return () => stateListeners.delete(listener);
  },

  saveTextFile: (request) => ipcRenderer.invoke('tabreach:save-text-file', request),
};

contextBridge.exposeInMainWorld('tabreach', bridge);
