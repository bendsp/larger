import type { LargerCanvasBridge } from "../electron/bridge";

declare global {
  interface Window {
    largerCanvas?: LargerCanvasBridge;
  }
}

export {};
