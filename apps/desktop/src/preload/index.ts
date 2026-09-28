// Sandboxed preload: the only bridge between the renderer and core (docs/06-API-CONTRACT.md).
import { contextBridge, ipcRenderer } from 'electron';
import {
  RpcError,
  RpcPeer,
  appRequestTimeoutsMs,
  isRequestType,
  requests,
  type MessageEndpoint,
  type TabReachBridge,
} from '@tabreach/protocol';

const CONNECT_TIMEOUT_MS = 10_000;

let peer: RpcPeer | null = null;
let waiters: Array<(p: RpcPeer) => void> = [];

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

// Main sends a fresh port on every page load and whenever core restarts.
ipcRenderer.on('tabreach:port', (event) => {
  const [port] = event.ports;
  if (!port) return;
  peer?.close();
  peer = new RpcPeer(domPortEndpoint(port));
  const ready = peer;
  for (const resolve of waiters.splice(0)) resolve(ready);
});

function connected(): Promise<RpcPeer> {
  if (peer) return Promise.resolve(peer);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== onReady);
      reject(new RpcError('UNAVAILABLE', 'Core is not running'));
    }, CONNECT_TIMEOUT_MS);
    const onReady = (p: RpcPeer) => {
      clearTimeout(timer);
      resolve(p);
    };
    waiters.push(onReady);
  });
}

const bridge: TabReachBridge = {
  async invoke(type, payload) {
    // Renderer code may only reach the app channel; host and browser messages are not addressable.
    if (!isRequestType(type) || requests[type].channel !== 'app') {
      return {
        ok: false,
        error: { code: 'UNKNOWN_MESSAGE_TYPE', title: 'Unknown message type', detail: String(type) },
      };
    }
    try {
      const timeoutMs = appRequestTimeoutsMs[type];
      const data = await (await connected()).request(type, payload, timeoutMs ? { timeoutMs } : {});
      return { ok: true, data };
    } catch (error) {
      if (error instanceof RpcError) return { ok: false, error: error.problem };
      return { ok: false, error: { code: 'INTERNAL', title: 'Unexpected error' } };
    }
  },
};

contextBridge.exposeInMainWorld('tabreach', bridge);
