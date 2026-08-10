import type { LargerCanvasBridge } from "../electron/bridge";
import type { LargerProjectsBridge } from "./project-ipc";

declare global {
  interface Window {
    larger?: { projects: LargerProjectsBridge };
    largerCanvas?: LargerCanvasBridge;
  }
}

export {};
