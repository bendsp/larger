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
import {
  CHANGE_IPC_CHANNELS,
  changeOperationResultSchema,
  changeWorkspaceSnapshotSchema,
  preparedApplyResultSchema,
  type LargerChangesBridge,
} from "../src/change-ipc.js";
import {
  RUNTIME_IPC_CHANNELS,
  runtimeOperationResultSchema,
  runtimeWorkspaceSnapshotSchema,
  type LargerRuntimeBridge,
} from "../src/runtime-ipc.js";

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

const changes: LargerChangesBridge = {
  getSnapshot: (generation) => invoke(CHANGE_IPC_CHANNELS.getSnapshot, changeWorkspaceSnapshotSchema, { generation }),
  scan: (generation) => invoke(CHANGE_IPC_CHANNELS.scan, changeOperationResultSchema, { generation }),
  updateSelection: (generation, changeSetId, expectedRevision, selection) => invoke(
    CHANGE_IPC_CHANNELS.updateSelection,
    changeOperationResultSchema,
    { generation, changeSetId, expectedRevision, selection },
  ),
  prepareApply: (generation, changeSetId, expectedRevision) => invoke(
    CHANGE_IPC_CHANNELS.prepareApply,
    preparedApplyResultSchema,
    { generation, changeSetId, expectedRevision },
  ),
  commitApply: (generation, transactionId, planDigest) => invoke(
    CHANGE_IPC_CHANNELS.commitApply,
    changeOperationResultSchema,
    { generation, transactionId, planDigest },
  ),
  discard: (generation, changeSetId, expectedRevision, confirmUnappliedLoss) => invoke(
    CHANGE_IPC_CHANNELS.discard,
    changeOperationResultSchema,
    { generation, changeSetId, expectedRevision, confirmUnappliedLoss },
  ),
  recover: (generation, transactionId, action) => invoke(
    CHANGE_IPC_CHANNELS.recover,
    changeOperationResultSchema,
    { generation, transactionId, action },
  ),
  onSnapshot(listener) {
    const handler = (_event: IpcRendererEvent, snapshot: unknown) => {
      const parsed = changeWorkspaceSnapshotSchema.safeParse(snapshot);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(CHANGE_IPC_CHANNELS.snapshot, handler);
    return () => ipcRenderer.removeListener(CHANGE_IPC_CHANNELS.snapshot, handler);
  },
};

const runtime: LargerRuntimeBridge = {
  getSnapshot: (generation) => invoke(RUNTIME_IPC_CHANNELS.getSnapshot, runtimeWorkspaceSnapshotSchema, { generation }),
  start: (generation, profileName, expectedRevision) => invoke(
    RUNTIME_IPC_CHANNELS.start,
    runtimeOperationResultSchema,
    { generation, profileName, expectedRevision },
  ),
  attach: (generation, url, expectedRevision) => invoke(
    RUNTIME_IPC_CHANNELS.attach,
    runtimeOperationResultSchema,
    { generation, url, expectedRevision },
  ),
  discover: (generation, expectedRevision) => invoke(
    RUNTIME_IPC_CHANNELS.discover,
    runtimeOperationResultSchema,
    { generation, expectedRevision },
  ),
  cancel: (generation, operationId) => invoke(
    RUNTIME_IPC_CHANNELS.cancel,
    runtimeOperationResultSchema,
    { generation, operationId },
  ),
  stop: (generation, sessionId, expectedRevision) => invoke(
    RUNTIME_IPC_CHANNELS.stop,
    runtimeOperationResultSchema,
    { generation, sessionId, expectedRevision },
  ),
  detach: (generation, sessionId, expectedRevision) => invoke(
    RUNTIME_IPC_CHANNELS.detach,
    runtimeOperationResultSchema,
    { generation, sessionId, expectedRevision },
  ),
  restart: (generation, sessionId, expectedRevision) => invoke(
    RUNTIME_IPC_CHANNELS.restart,
    runtimeOperationResultSchema,
    { generation, sessionId, expectedRevision },
  ),
  onSnapshot(listener) {
    const handler = (_event: IpcRendererEvent, snapshot: unknown) => {
      const parsed = runtimeWorkspaceSnapshotSchema.safeParse(snapshot);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(RUNTIME_IPC_CHANNELS.snapshot, handler);
    return () => ipcRenderer.removeListener(RUNTIME_IPC_CHANNELS.snapshot, handler);
  },
};

const canvas: LargerCanvasBridge = {
  load: (generation, surfaceId) => ipcRenderer.invoke("canvas:load", { generation, surfaceId }),
  navigate: (generation, surfaceId, route) => ipcRenderer.invoke("canvas:navigate", { generation, surfaceId, route }),
  setBounds: (generation, bounds) => ipcRenderer.send("canvas:bounds", { generation, bounds }),
  show: (generation, surfaceId) => ipcRenderer.send("canvas:show", { generation, surfaceId }),
  focus: (generation, surfaceId) => ipcRenderer.send("canvas:focus", { generation, surfaceId }),
  hide: () => ipcRenderer.send("canvas:hide"),
  onNavigation(listener) {
    const handler = (
      _event: IpcRendererEvent,
      navigation: { generation: number; surfaceId: string; route: string },
    ) => listener(navigation);
    ipcRenderer.on("canvas:navigated", handler);
    return () => ipcRenderer.removeListener("canvas:navigated", handler);
  },
  onFocusReturn(listener) {
    const handler = (
      _event: IpcRendererEvent,
      navigation: { generation: number; surfaceId: string },
    ) => listener(navigation);
    ipcRenderer.on("canvas:focus-return", handler);
    return () => ipcRenderer.removeListener("canvas:focus-return", handler);
  },
};

contextBridge.exposeInMainWorld("larger", { projects, changes, runtime });
contextBridge.exposeInMainWorld("largerCanvas", canvas);
