import type { MessagePortMain, UtilityProcess } from 'electron';
import type { MessageEndpoint } from '@tabreach/protocol';

/** Control message main sends to a utility process together with a transferred port. */
export interface PortHandoff {
  __tabreach: 'port';
  name: 'app' | 'browser';
}

export function isPortHandoff(value: unknown): value is PortHandoff {
  return (
    typeof value === 'object' && value !== null && (value as { __tabreach?: unknown }).__tabreach === 'port'
  );
}

/** A MessagePortMain (main process side, or received inside a utility process). */
export function portEndpoint(port: MessagePortMain): MessageEndpoint {
  const listeners = new Set<(m: unknown) => void>();
  port.on('message', (event) => {
    for (const l of listeners) l(event.data);
  });
  port.start();
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Main process side of the parent channel to a utility process (the "host" channel). */
export function utilityProcessEndpoint(child: UtilityProcess): MessageEndpoint {
  const listeners = new Set<(m: unknown) => void>();
  child.on('message', (message: unknown) => {
    for (const l of listeners) l(message);
  });
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Utility process side of the parent channel. Port handoffs are routed to `onPort`;
 * everything else is protocol traffic.
 */
export function parentPortEndpoint(
  parentPort: Electron.ParentPort,
  onPort: (handoff: PortHandoff, port: MessagePortMain) => void,
): MessageEndpoint {
  const listeners = new Set<(m: unknown) => void>();
  parentPort.on('message', (event) => {
    const [port] = event.ports;
    if (isPortHandoff(event.data)) {
      if (port) onPort(event.data, port);
      return;
    }
    for (const l of listeners) l(event.data);
  });
  return {
    postMessage: (message) => parentPort.postMessage(message),
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Paths and version that main passes to child processes through the environment. */
/** Exit code core uses to ask for an immediate restart (a restore is applied on start), not a crash. */
export const RESTART_EXIT_CODE = 75;

export interface ChildEnv {
  TABREACH_DATA_DIR: string;
  TABREACH_LOG_DIR: string;
  TABREACH_APP_VERSION: string;
  TABREACH_DEV: '0' | '1';
}

export function readChildEnv(env: NodeJS.ProcessEnv): ChildEnv {
  const get = (key: keyof ChildEnv): string => {
    const value = env[key];
    if (!value) throw new Error(`Missing ${key} in child process environment`);
    return value;
  };
  return {
    TABREACH_DATA_DIR: get('TABREACH_DATA_DIR'),
    TABREACH_LOG_DIR: get('TABREACH_LOG_DIR'),
    TABREACH_APP_VERSION: get('TABREACH_APP_VERSION'),
    TABREACH_DEV: env.TABREACH_DEV === '1' ? '1' : '0',
  };
}
