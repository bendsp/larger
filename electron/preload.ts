import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  PROJECT_IPC_CHANNELS,
  projectLifecycleSnapshotSchema,
  projectOperationResultSchema,
  type IpcEnvelope,
  type LargerProjectsBridge,
} from "../src/project-ipc.js";
import type { ZodType } from "zod";
import type { ProjectManifest, ProjectPersonalState } from "../src/project-contracts.js";
import type { LargerCanvasBridge } from "./bridge.js";

async function invoke<T>(channel: string, schema: ZodType<T>, input?: unknown): Promise<T> {
  const envelope = await ipcRenderer.invoke(channel, input) as IpcEnvelope<T>;
  if (!envelope || typeof envelope !== "object" || typeof envelope.ok !== "boolean") {
    throw new Error("Electron returned an invalid IPC response");
  }
  if (!envelope.ok) {
    const failure = (envelope as { error?: unknown }).error;
    if (
      !failure
      || typeof failure !== "object"
      || !("message" in failure)
      || typeof failure.message !== "string"
      || !("code" in failure)
      || typeof failure.code !== "string"
    ) {
      throw new Error("Electron returned an invalid IPC error response");
    }
    const error = new Error(failure.message);
    error.name = failure.code;
    throw error;
  }
  return schema.parse(envelope.value);
}

const projects: LargerProjectsBridge = {
  getSnapshot: () => invoke(PROJECT_IPC_CHANNELS.getSnapshot, projectLifecycleSnapshotSchema),
  pickAndOpen: () => invoke(PROJECT_IPC_CHANNELS.pickAndOpen, projectOperationResultSchema),
  openRecent: (instanceKey) => invoke(PROJECT_IPC_CHANNELS.openRecent, projectOperationResultSchema, { instanceKey }),
  initialize: (generation: number, manifest: ProjectManifest) => (
    invoke(PROJECT_IPC_CHANNELS.initialize, projectOperationResultSchema, { generation, manifest })
  ),
  updateManifest: (generation: number, manifest: ProjectManifest) => (
    invoke(PROJECT_IPC_CHANNELS.updateManifest, projectOperationResultSchema, { generation, manifest })
  ),
  dismissPending: (generation) => invoke(PROJECT_IPC_CHANNELS.dismissPending, projectOperationResultSchema, { generation }),
  setTrust: (generation, decision) => invoke(PROJECT_IPC_CHANNELS.setTrust, projectOperationResultSchema, { generation, decision }),
  refresh: (generation) => invoke(PROJECT_IPC_CHANNELS.refresh, projectOperationResultSchema, { generation }),
  close: (generation) => invoke(PROJECT_IPC_CHANNELS.close, projectOperationResultSchema, { generation }),
  removeRecent: (instanceKey) => invoke(PROJECT_IPC_CHANNELS.removeRecent, projectOperationResultSchema, { instanceKey }),
  updatePersonalState: (generation: number, personalState: ProjectPersonalState) => (
    invoke(PROJECT_IPC_CHANNELS.updatePersonalState, projectOperationResultSchema, { generation, personalState })
  ),
  prepareWorkspace: (generation) => invoke(PROJECT_IPC_CHANNELS.prepareWorkspace, projectOperationResultSchema, { generation }),
  onSnapshot(listener) {
    const handler = (_event: IpcRendererEvent, snapshot: unknown) => {
      const parsed = projectLifecycleSnapshotSchema.safeParse(snapshot);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(PROJECT_IPC_CHANNELS.snapshot, handler);
    return () => ipcRenderer.removeListener(PROJECT_IPC_CHANNELS.snapshot, handler);
  },
};

const canvas: LargerCanvasBridge = {
  load: (generation, url) => ipcRenderer.invoke("canvas:load", { generation, url }),
  navigate: (generation, url) => ipcRenderer.invoke("canvas:navigate", { generation, url }),
  setBounds: (generation, bounds) => ipcRenderer.send("canvas:bounds", { generation, bounds }),
  show: (generation) => ipcRenderer.send("canvas:show", { generation }),
  hide: () => ipcRenderer.send("canvas:hide"),
  onNavigation(listener) {
    const handler = (_event: IpcRendererEvent, navigation: { generation: number; url: string }) => listener(navigation);
    ipcRenderer.on("canvas:navigated", handler);
    return () => ipcRenderer.removeListener("canvas:navigated", handler);
  },
};

contextBridge.exposeInMainWorld("larger", { projects });
contextBridge.exposeInMainWorld("largerCanvas", canvas);
