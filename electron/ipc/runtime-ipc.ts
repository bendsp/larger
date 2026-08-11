import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { ZodError, type ZodType } from "zod";
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
import type { IpcDomainError, IpcEnvelope } from "../../src/project-ipc.js";

export interface RuntimeServicePort {
  snapshot(generation: number): Promise<RuntimeWorkspaceSnapshot> | RuntimeWorkspaceSnapshot;
  start(generation: number, profileName: string, expectedRevision: number): Promise<RuntimeOperationResult>;
  attach(generation: number, url: string, expectedRevision: number): Promise<RuntimeOperationResult>;
  discover(generation: number, expectedRevision: number): Promise<RuntimeOperationResult>;
  cancel(generation: number, operationId: string): Promise<RuntimeOperationResult>;
  stop(generation: number, sessionId: string, expectedRevision: number): Promise<RuntimeOperationResult>;
  detach(generation: number, sessionId: string, expectedRevision: number): Promise<RuntimeOperationResult>;
  restart(generation: number, sessionId: string, expectedRevision: number): Promise<RuntimeOperationResult>;
  subscribe(listener: (snapshot: RuntimeWorkspaceSnapshot) => void): () => void;
}

export interface RuntimeIpcDependencies {
  readonly ipcMain: IpcMain;
  readonly service: RuntimeServicePort;
  readonly getWindow: () => BrowserWindow | null;
  readonly assertTrustedSender: (event: IpcMainInvokeEvent) => void;
}

function domainError(cause: unknown): IpcDomainError {
  if (cause instanceof ZodError) {
    return {
      code: "invalid-ipc-payload",
      message: "The runtime operation contained invalid data.",
      details: cause.issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message })),
    };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = /stale/i.test(message) ? "stale-generation" : "runtime-operation-failed";
  return { code, message };
}

export function registerRuntimeIpc(dependencies: RuntimeIpcDependencies): () => void {
  const { ipcMain, service, getWindow, assertTrustedSender } = dependencies;
  const channels: string[] = [];

  function handle<TInput, TResult>(
    channel: string,
    inputSchema: ZodType<TInput>,
    outputSchema: ZodType<TResult>,
    operation: (input: TInput) => Promise<TResult> | TResult,
  ): void {
    channels.push(channel);
    ipcMain.handle(channel, async (event, raw: unknown): Promise<IpcEnvelope<TResult>> => {
      try {
        assertTrustedSender(event);
        const input = inputSchema.parse(raw);
        const value = outputSchema.parse(await operation(input));
        return { ok: true, value };
      } catch (cause) {
        return { ok: false, error: domainError(cause) };
      }
    });
  }

  handle(
    RUNTIME_IPC_CHANNELS.getSnapshot,
    runtimeGenerationInputSchema,
    runtimeWorkspaceSnapshotSchema,
    ({ generation }) => service.snapshot(generation),
  );
  handle(
    RUNTIME_IPC_CHANNELS.start,
    runtimeStartInputSchema,
    runtimeOperationResultSchema,
    ({ generation, profileName, expectedRevision }) => service.start(generation, profileName, expectedRevision),
  );
  handle(
    RUNTIME_IPC_CHANNELS.attach,
    runtimeAttachInputSchema,
    runtimeOperationResultSchema,
    ({ generation, url, expectedRevision }) => service.attach(generation, url, expectedRevision),
  );
  handle(
    RUNTIME_IPC_CHANNELS.discover,
    runtimeDiscoverInputSchema,
    runtimeOperationResultSchema,
    ({ generation, expectedRevision }) => service.discover(generation, expectedRevision),
  );
  handle(
    RUNTIME_IPC_CHANNELS.cancel,
    runtimeCancelInputSchema,
    runtimeOperationResultSchema,
    ({ generation, operationId }) => service.cancel(generation, operationId),
  );
  handle(
    RUNTIME_IPC_CHANNELS.stop,
    runtimeSessionMutationInputSchema,
    runtimeOperationResultSchema,
    ({ generation, sessionId, expectedRevision }) => service.stop(generation, sessionId, expectedRevision),
  );
  handle(
    RUNTIME_IPC_CHANNELS.detach,
    runtimeSessionMutationInputSchema,
    runtimeOperationResultSchema,
    ({ generation, sessionId, expectedRevision }) => service.detach(generation, sessionId, expectedRevision),
  );
  handle(
    RUNTIME_IPC_CHANNELS.restart,
    runtimeSessionMutationInputSchema,
    runtimeOperationResultSchema,
    ({ generation, sessionId, expectedRevision }) => service.restart(generation, sessionId, expectedRevision),
  );

  const unsubscribe = service.subscribe((snapshot) => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    const parsed = runtimeWorkspaceSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) return;
    window.webContents.send(RUNTIME_IPC_CHANNELS.snapshot, parsed.data);
  });

  return () => {
    unsubscribe();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
