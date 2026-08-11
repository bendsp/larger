import type { LargerCanvasBridge } from "../electron/bridge";
import type { LargerProjectsBridge } from "./project-ipc";
import type { LargerChangesBridge } from "./change-ipc";
import type { LargerRuntimeBridge } from "./runtime-ipc";

declare global {
  interface Window {
    larger?: { projects: LargerProjectsBridge; changes: LargerChangesBridge; runtime: LargerRuntimeBridge };
    largerCanvas?: LargerCanvasBridge;
  }
}

export {};
