import type { ZodType } from "zod";
import {
  PROJECT_IPC_CHANNELS,
  projectLifecycleSnapshotSchema,
  projectOperationResultSchema,
  type LargerProjectsBridge,
} from "../src/project-ipc.js";
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
import {
  APPLICATION_IPC_CHANNELS,
  applicationSnapshotSchema,
  applicationVoidSchema,
  type LargerApplicationBridge,
} from "../src/desktop/application-contract.js";
import {
  CANVAS_IPC_CHANNELS,
  canvasAckSchema,
  canvasFocusReturnSchema,
  canvasNavigationSchema,
  type LargerCanvasBridge,
} from "../src/desktop/canvas-contract.js";

export interface PreloadTransport {
  invoke<T>(channel: string, schema: ZodType<T>, payload?: unknown): Promise<T>;
  send(channel: string, payload: unknown): void;
  subscribe<T>(
    channel: string,
    stream: string,
    schema: ZodType<T>,
    listener: (value: T) => void,
  ): () => void;
}

export interface LargerDesktopBridge {
  readonly application: LargerApplicationBridge;
  readonly projects: LargerProjectsBridge;
  readonly changes: LargerChangesBridge;
  readonly runtime: LargerRuntimeBridge;
  readonly canvas: LargerCanvasBridge;
}

export function createPreloadBridge(transport: PreloadTransport): LargerDesktopBridge {
  const application: LargerApplicationBridge = {
    getSnapshot: () => transport.invoke(APPLICATION_IPC_CHANNELS.getSnapshot, applicationSnapshotSchema),
    retry: () => transport.invoke(APPLICATION_IPC_CHANNELS.retry, applicationSnapshotSchema),
    quit: async () => {
      await transport.invoke(APPLICATION_IPC_CHANNELS.quit, applicationVoidSchema);
    },
    onSnapshot: (listener) => transport.subscribe(
      APPLICATION_IPC_CHANNELS.snapshot,
      "application.snapshot",
      applicationSnapshotSchema,
      listener,
    ),
  };

  const projects: LargerProjectsBridge = {
    getSnapshot: () => transport.invoke(PROJECT_IPC_CHANNELS.getSnapshot, projectLifecycleSnapshotSchema),
    pickAndOpen: () => transport.invoke(PROJECT_IPC_CHANNELS.pickAndOpen, projectOperationResultSchema),
    openRecent: (instanceKey) => transport.invoke(
      PROJECT_IPC_CHANNELS.openRecent,
      projectOperationResultSchema,
      { instanceKey },
    ),
    initialize: (generation, manifest) => transport.invoke(
      PROJECT_IPC_CHANNELS.initialize,
      projectOperationResultSchema,
      { generation, manifest },
    ),
    updateManifest: (generation, manifest) => transport.invoke(
      PROJECT_IPC_CHANNELS.updateManifest,
      projectOperationResultSchema,
      { generation, manifest },
    ),
    dismissPending: (generation) => transport.invoke(
      PROJECT_IPC_CHANNELS.dismissPending,
      projectOperationResultSchema,
      { generation },
    ),
    setTrust: (generation, decision) => transport.invoke(
      PROJECT_IPC_CHANNELS.setTrust,
      projectOperationResultSchema,
      { generation, decision },
    ),
    refresh: (generation) => transport.invoke(
      PROJECT_IPC_CHANNELS.refresh,
      projectOperationResultSchema,
      { generation },
    ),
    close: (generation) => transport.invoke(
      PROJECT_IPC_CHANNELS.close,
      projectOperationResultSchema,
      { generation },
    ),
    removeRecent: (instanceKey) => transport.invoke(
      PROJECT_IPC_CHANNELS.removeRecent,
      projectOperationResultSchema,
      { instanceKey },
    ),
    updatePersonalState: (generation, personalState) => transport.invoke(
      PROJECT_IPC_CHANNELS.updatePersonalState,
      projectOperationResultSchema,
      { generation, personalState },
    ),
    prepareWorkspace: (generation) => transport.invoke(
      PROJECT_IPC_CHANNELS.prepareWorkspace,
      projectOperationResultSchema,
      { generation },
    ),
    onSnapshot: (listener) => transport.subscribe(
      PROJECT_IPC_CHANNELS.snapshot,
      "projects.snapshot",
      projectLifecycleSnapshotSchema,
      listener,
    ),
  };

  const changes: LargerChangesBridge = {
    getSnapshot: (generation) => transport.invoke(
      CHANGE_IPC_CHANNELS.getSnapshot,
      changeWorkspaceSnapshotSchema,
      { generation },
    ),
    scan: (generation) => transport.invoke(
      CHANGE_IPC_CHANNELS.scan,
      changeOperationResultSchema,
      { generation },
    ),
    updateSelection: (generation, changeSetId, expectedRevision, selection) => transport.invoke(
      CHANGE_IPC_CHANNELS.updateSelection,
      changeOperationResultSchema,
      { generation, changeSetId, expectedRevision, selection },
    ),
    prepareApply: (generation, changeSetId, expectedRevision) => transport.invoke(
      CHANGE_IPC_CHANNELS.prepareApply,
      preparedApplyResultSchema,
      { generation, changeSetId, expectedRevision },
    ),
    commitApply: (generation, transactionId, planDigest) => transport.invoke(
      CHANGE_IPC_CHANNELS.commitApply,
      changeOperationResultSchema,
      { generation, transactionId, planDigest },
    ),
    discard: (generation, changeSetId, expectedRevision, confirmUnappliedLoss) => transport.invoke(
      CHANGE_IPC_CHANNELS.discard,
      changeOperationResultSchema,
      { generation, changeSetId, expectedRevision, confirmUnappliedLoss },
    ),
    recover: (generation, transactionId, action) => transport.invoke(
      CHANGE_IPC_CHANNELS.recover,
      changeOperationResultSchema,
      { generation, transactionId, action },
    ),
    onSnapshot: (listener) => transport.subscribe(
      CHANGE_IPC_CHANNELS.snapshot,
      "changes.snapshot",
      changeWorkspaceSnapshotSchema,
      listener,
    ),
  };

  const runtime: LargerRuntimeBridge = {
    getSnapshot: (generation) => transport.invoke(
      RUNTIME_IPC_CHANNELS.getSnapshot,
      runtimeWorkspaceSnapshotSchema,
      { generation },
    ),
    start: (generation, profileName, expectedRevision) => transport.invoke(
      RUNTIME_IPC_CHANNELS.start,
      runtimeOperationResultSchema,
      { generation, profileName, expectedRevision },
    ),
    attach: (generation, url, expectedRevision) => transport.invoke(
      RUNTIME_IPC_CHANNELS.attach,
      runtimeOperationResultSchema,
      { generation, url, expectedRevision },
    ),
    discover: (generation, expectedRevision) => transport.invoke(
      RUNTIME_IPC_CHANNELS.discover,
      runtimeOperationResultSchema,
      { generation, expectedRevision },
    ),
    cancel: (generation, operationId) => transport.invoke(
      RUNTIME_IPC_CHANNELS.cancel,
      runtimeOperationResultSchema,
      { generation, operationId },
    ),
    stop: (generation, sessionId, expectedRevision) => transport.invoke(
      RUNTIME_IPC_CHANNELS.stop,
      runtimeOperationResultSchema,
      { generation, sessionId, expectedRevision },
    ),
    detach: (generation, sessionId, expectedRevision) => transport.invoke(
      RUNTIME_IPC_CHANNELS.detach,
      runtimeOperationResultSchema,
      { generation, sessionId, expectedRevision },
    ),
    restart: (generation, sessionId, expectedRevision) => transport.invoke(
      RUNTIME_IPC_CHANNELS.restart,
      runtimeOperationResultSchema,
      { generation, sessionId, expectedRevision },
    ),
    onSnapshot: (listener) => transport.subscribe(
      RUNTIME_IPC_CHANNELS.snapshot,
      "runtime.snapshot",
      runtimeWorkspaceSnapshotSchema,
      listener,
    ),
  };

  const canvas: LargerCanvasBridge = {
    load: (generation, surfaceId) => transport.invoke(
      CANVAS_IPC_CHANNELS.load,
      canvasAckSchema,
      { generation, surfaceId },
    ),
    navigate: (generation, surfaceId, route) => transport.invoke(
      CANVAS_IPC_CHANNELS.navigate,
      canvasAckSchema,
      { generation, surfaceId, route },
    ),
    setBounds: (generation, surfaceId, bounds) => transport.send(
      CANVAS_IPC_CHANNELS.bounds,
      { generation, surfaceId, bounds },
    ),
    show: (generation, surfaceId) => transport.send(CANVAS_IPC_CHANNELS.show, { generation, surfaceId }),
    focus: (generation, surfaceId) => transport.send(CANVAS_IPC_CHANNELS.focus, { generation, surfaceId }),
    hide: (generation, surfaceId) => transport.send(CANVAS_IPC_CHANNELS.hide, { generation, surfaceId }),
    onNavigation: (listener) => transport.subscribe(
      CANVAS_IPC_CHANNELS.navigated,
      "canvas.navigated",
      canvasNavigationSchema,
      listener,
    ),
    onFocusReturn: (listener) => transport.subscribe(
      CANVAS_IPC_CHANNELS.focusReturn,
      "canvas.focus-return",
      canvasFocusReturnSchema,
      listener,
    ),
  };

  return { application, projects, changes, runtime, canvas };
}
