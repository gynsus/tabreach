import type { MessageEndpoint } from './rpc.js';

/**
 * In-memory endpoint pair for tests. Messages are structured-cloned and delivered
 * asynchronously, like a real MessagePort.
 */
export function createEndpointPair(): [MessageEndpoint, MessageEndpoint] {
  const listeners: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [new Set(), new Set()];
  const make = (self: 0 | 1): MessageEndpoint => ({
    postMessage(message) {
      const copy = structuredClone(message);
      queueMicrotask(() => {
        for (const l of listeners[self === 0 ? 1 : 0]) l(copy);
      });
    },
    onMessage(listener) {
      listeners[self].add(listener);
      return () => listeners[self].delete(listener);
    },
  });
  return [make(0), make(1)];
}
