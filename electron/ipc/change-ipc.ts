import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { ZodError, type ZodType } from "zod";
import {
  CHANGE_IPC_CHANNELS,
  changeGenerationInputSchema,
  changeSelectionInputSchema,
  changeSetMutationInputSchema,
  commitApplyInputSchema,
  discardInputSchema,
  recoverInputSchema,
  type ChangeOperationResult,
  type ChangeWorkspaceSnapshot,
  type PreparedApplyResult,
} from "../../src/change-ipc.js";
import type { IpcDomainError, IpcEnvelope } from "../../src/project-ipc.js";

export interface ChangeServicePort {
  snapshot(generation: number): Promise<ChangeWorkspaceSnapshot> | ChangeWorkspaceSnapshot;
  scan(generation: number): Promise<ChangeOperationResult>;
  updateSelection(
    generation: number,
    changeSetId: string,
    expectedRevision: number,
    selection: import("../../src/change-contracts.js").ChangeSelection,
  ): Promise<ChangeOperationResult>;
  prepareApply(generation: number, changeSetId: string, expectedRevision: number): Promise<PreparedApplyResult>;
  commitApply(generation: number, transactionId: string, planDigest: string): Promise<ChangeOperationResult>;
  discard(
    generation: number,
    changeSetId: string,
    expectedRevision: number,
    confirmUnappliedLoss: true,
  ): Promise<ChangeOperationResult>;
  recover(
    generation: number,
    transactionId: string,
    action: import("../../src/change-contracts.js").RecoveryAction,
  ): Promise<ChangeOperationResult>;
  subscribe(listener: (snapshot: ChangeWorkspaceSnapshot) => void): () => void;
}

export interface ChangeIpcDependencies {
  readonly ipcMain: IpcMain;
  readonly service: ChangeServicePort;
  readonly getWindow: () => BrowserWindow | null;
  readonly assertTrustedSender: (event: IpcMainInvokeEvent) => void;
}

function domainError(cause: unknown): IpcDomainError {
  if (cause instanceof ZodError) {
    return {
      code: "invalid-ipc-payload",
      message: "The renderer sent an invalid change operation.",
      details: cause.issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message })),
    };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return { code: "change-operation-failed", message };
}

export function registerChangeIpc(dependencies: ChangeIpcDependencies): () => void {
  const { ipcMain, service, getWindow, assertTrustedSender } = dependencies;
  const channels: string[] = [];

  function handle<TInput, TResult>(
    channel: string,
    schema: ZodType<TInput>,
    operation: (input: TInput) => Promise<TResult> | TResult,
  ): void {
    channels.push(channel);
    ipcMain.handle(channel, async (event, raw: unknown): Promise<IpcEnvelope<TResult>> => {
      try {
        assertTrustedSender(event);
        return { ok: true, value: await operation(schema.parse(raw)) };
      } catch (cause) {
        return { ok: false, error: domainError(cause) };
      }
    });
  }

  handle(CHANGE_IPC_CHANNELS.getSnapshot, changeGenerationInputSchema, ({ generation }) => service.snapshot(generation));
  handle(CHANGE_IPC_CHANNELS.scan, changeGenerationInputSchema, ({ generation }) => service.scan(generation));
  handle(CHANGE_IPC_CHANNELS.updateSelection, changeSelectionInputSchema, ({ generation, changeSetId, expectedRevision, selection }) => (
    service.updateSelection(generation, changeSetId, expectedRevision, selection)
  ));
  handle(CHANGE_IPC_CHANNELS.prepareApply, changeSetMutationInputSchema, ({ generation, changeSetId, expectedRevision }) => (
    service.prepareApply(generation, changeSetId, expectedRevision)
  ));
  handle(CHANGE_IPC_CHANNELS.commitApply, commitApplyInputSchema, ({ generation, transactionId, planDigest }) => (
    service.commitApply(generation, transactionId, planDigest)
  ));
  handle(CHANGE_IPC_CHANNELS.discard, discardInputSchema, ({ generation, changeSetId, expectedRevision, confirmUnappliedLoss }) => (
    service.discard(generation, changeSetId, expectedRevision, confirmUnappliedLoss)
  ));
  handle(CHANGE_IPC_CHANNELS.recover, recoverInputSchema, ({ generation, transactionId, action }) => (
    service.recover(generation, transactionId, action)
  ));

  const unsubscribe = service.subscribe((snapshot) => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(CHANGE_IPC_CHANNELS.snapshot, snapshot);
  });

  return () => {
    unsubscribe();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
