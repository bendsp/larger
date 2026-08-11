import type { BrowserWindow } from "electron";
import {
  RUNTIME_IPC_CHANNELS,
  runtimeAttachInputSchema,
  runtimeCancelInputSchema,
  runtimeDiscoverInputSchema,
  runtimeGenerationInputSchema,
  runtimeOperationResultSchema,
  runtimeSessionMutationInputSchema,
  runtimeStartInputSchema,
  runtimeWorkspaceSnapshotSchema,
} from "../../src/runtime-ipc.js";
import type { RuntimeOperationResult, RuntimeWorkspaceSnapshot } from "../../src/runtime-contracts.js";
import type { DesktopIpcRouter } from "./desktop-ipc-router.js";

export interface RuntimeServicePort {
  snapshot(generation: number): Promise<RuntimeWorkspaceSnapshot> | RuntimeWorkspaceSnapshot;
  start(generation: number, profileName: string, expectedRevision: number, options?: { readonly signal?: AbortSignal }): Promise<RuntimeOperationResult>;
  attach(generation: number, url: string, expectedRevision: number, options?: { readonly signal?: AbortSignal }): Promise<RuntimeOperationResult>;
  discover(generation: number, expectedRevision: number, options?: { readonly signal?: AbortSignal }): Promise<RuntimeOperationResult>;
  cancel(generation: number, operationId: string, options?: { readonly signal?: AbortSignal }): Promise<RuntimeOperationResult>;
  stop(generation: number, sessionId: string, expectedRevision: number, options?: { readonly signal?: AbortSignal }): Promise<RuntimeOperationResult>;
  detach(generation: number, sessionId: string, expectedRevision: number, options?: { readonly signal?: AbortSignal }): Promise<RuntimeOperationResult>;
  restart(generation: number, sessionId: string, expectedRevision: number, options?: { readonly signal?: AbortSignal }): Promise<RuntimeOperationResult>;
  subscribe(listener: (snapshot: RuntimeWorkspaceSnapshot) => void): () => void;
}

export interface RuntimeIpcDependencies {
  readonly router: DesktopIpcRouter;
  readonly service: RuntimeServicePort;
  readonly getWindow: () => BrowserWindow | null;
}

export function registerRuntimeIpc(dependencies: RuntimeIpcDependencies): () => void {
  const { router, service, getWindow } = dependencies;
  const disposeHandlers = [
    router.register({
      channel: RUNTIME_IPC_CHANNELS.getSnapshot,
      input: runtimeGenerationInputSchema,
      output: runtimeWorkspaceSnapshotSchema,
      failureCode: "runtime-operation-failed",
      run: ({ generation }) => service.snapshot(generation),
    }),
    router.register({
      channel: RUNTIME_IPC_CHANNELS.start,
      input: runtimeStartInputSchema,
      output: runtimeOperationResultSchema,
      failureCode: "runtime-operation-failed",
      run: ({ generation, profileName, expectedRevision }, context) => (
        service.start(generation, profileName, expectedRevision, { signal: context.signal })
      ),
    }),
    router.register({
      channel: RUNTIME_IPC_CHANNELS.attach,
      input: runtimeAttachInputSchema,
      output: runtimeOperationResultSchema,
      failureCode: "runtime-operation-failed",
      run: ({ generation, url, expectedRevision }, context) => (
        service.attach(generation, url, expectedRevision, { signal: context.signal })
      ),
    }),
    router.register({
      channel: RUNTIME_IPC_CHANNELS.discover,
      input: runtimeDiscoverInputSchema,
      output: runtimeOperationResultSchema,
      failureCode: "runtime-operation-failed",
      run: ({ generation, expectedRevision }, context) => (
        service.discover(generation, expectedRevision, { signal: context.signal })
      ),
    }),
    router.register({
      channel: RUNTIME_IPC_CHANNELS.cancel,
      input: runtimeCancelInputSchema,
      output: runtimeOperationResultSchema,
      failureCode: "runtime-operation-failed",
      run: ({ generation, operationId }, context) => service.cancel(generation, operationId, { signal: context.signal }),
    }),
    router.register({
      channel: RUNTIME_IPC_CHANNELS.stop,
      input: runtimeSessionMutationInputSchema,
      output: runtimeOperationResultSchema,
      failureCode: "runtime-operation-failed",
      run: ({ generation, sessionId, expectedRevision }, context) => (
        service.stop(generation, sessionId, expectedRevision, { signal: context.signal })
      ),
    }),
    router.register({
      channel: RUNTIME_IPC_CHANNELS.detach,
      input: runtimeSessionMutationInputSchema,
      output: runtimeOperationResultSchema,
      failureCode: "runtime-operation-failed",
      run: ({ generation, sessionId, expectedRevision }, context) => (
        service.detach(generation, sessionId, expectedRevision, { signal: context.signal })
      ),
    }),
    router.register({
      channel: RUNTIME_IPC_CHANNELS.restart,
      input: runtimeSessionMutationInputSchema,
      output: runtimeOperationResultSchema,
      failureCode: "runtime-operation-failed",
      run: ({ generation, sessionId, expectedRevision }, context) => (
        service.restart(generation, sessionId, expectedRevision, { signal: context.signal })
      ),
    }),
  ];

  const unsubscribe = service.subscribe((snapshot) => {
    router.publish(
      getWindow(),
      RUNTIME_IPC_CHANNELS.snapshot,
      "runtime.snapshot",
      runtimeWorkspaceSnapshotSchema,
      snapshot,
    );
  });

  return () => {
    unsubscribe();
    for (const dispose of disposeHandlers) dispose();
  };
}
