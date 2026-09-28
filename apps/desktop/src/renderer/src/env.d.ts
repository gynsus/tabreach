/// <reference types="vite/client" />
import type { TabReachBridge } from '@tabreach/protocol';

declare global {
  interface Window {
    tabreach: TabReachBridge;
  }
}

export {};
