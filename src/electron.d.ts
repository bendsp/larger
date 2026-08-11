import type { LargerProjectsBridge } from "./project-ipc";
import type { LargerChangesBridge } from "./change-ipc";
import type { LargerRuntimeBridge } from "./runtime-ipc";
import type { LargerApplicationBridge } from "./desktop/application-contract";
import type { LargerCanvasBridge } from "./desktop/canvas-contract";

declare global {
  interface Window {
    larger?: {
      application: LargerApplicationBridge;
      projects: LargerProjectsBridge;
      changes: LargerChangesBridge;
      runtime: LargerRuntimeBridge;
      canvas: LargerCanvasBridge;
    };
  }
}

export {};
