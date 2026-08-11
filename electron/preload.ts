import { contextBridge, ipcRenderer } from "electron";
import { createPreloadBridge } from "./preload-bridge.js";
import { createPreloadTransport } from "./preload-transport.js";

function randomUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function reportBridgeFailure(cause: unknown): void {
  console.error("Larger desktop bridge rejected an IPC message", cause);
}
const transport = createPreloadTransport({ ipcRenderer, createId: randomUuid, reportFailure: reportBridgeFailure });
const bridge = createPreloadBridge(transport);
contextBridge.exposeInMainWorld("larger", bridge);
