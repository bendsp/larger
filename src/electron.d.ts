import type { LargerCanvasBridge } from "../electron/bridge";
import type { LargerProjectsBridge } from "./project-ipc";
import type { LargerChangesBridge } from "./change-ipc";

declare global {
  interface Window {
    larger?: { projects: LargerProjectsBridge; changes: LargerChangesBridge };
    largerCanvas?: LargerCanvasBridge;
  }
}

export {};
