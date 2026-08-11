import type { BrowserWindow } from "electron";
import {
  CHANGE_IPC_CHANNELS,
  changeGenerationInputSchema,
  changeOperationResultSchema,
  changeSelectionInputSchema,
  changeSetMutationInputSchema,
  changeWorkspaceSnapshotSchema,
  commitApplyInputSchema,
  discardInputSchema,
  preparedApplyResultSchema,
  recoverInputSchema,
  type ChangeOperationResult,
  type ChangeWorkspaceSnapshot,
  type PreparedApplyResult,
} from "../../src/change-ipc.js";
import type { DesktopIpcRouter } from "./desktop-ipc-router.js";

export interface ChangeServicePort {
  snapshot(generation: number): Promise<ChangeWorkspaceSnapshot> | ChangeWorkspaceSnapshot;
  scan(generation: number, options?: { readonly signal?: AbortSignal }): Promise<ChangeOperationResult>;
  updateSelection(
    generation: number,
    changeSetId: string,
    expectedRevision: number,
    selection: import("../../src/change-contracts.js").ChangeSelection,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ChangeOperationResult>;
  prepareApply(generation: number, changeSetId: string, expectedRevision: number, options?: { readonly signal?: AbortSignal }): Promise<PreparedApplyResult>;
  commitApply(generation: number, transactionId: string, planDigest: string, options?: { readonly signal?: AbortSignal }): Promise<ChangeOperationResult>;
  discard(
    generation: number,
    changeSetId: string,
    expectedRevision: number,
    confirmUnappliedLoss: true,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ChangeOperationResult>;
  recover(
    generation: number,
    transactionId: string,
    action: import("../../src/change-contracts.js").RecoveryAction,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ChangeOperationResult>;
  subscribe(listener: (snapshot: ChangeWorkspaceSnapshot) => void): () => void;
}

export interface ChangeIpcDependencies {
  readonly router: DesktopIpcRouter;
  readonly service: ChangeServicePort;
  readonly getWindow: () => BrowserWindow | null;
}

export function registerChangeIpc(dependencies: ChangeIpcDependencies): () => void {
  const { router, service, getWindow } = dependencies;
  const disposeHandlers = [
    router.register({
      channel: CHANGE_IPC_CHANNELS.getSnapshot,
      input: changeGenerationInputSchema,
      output: changeWorkspaceSnapshotSchema,
      failureCode: "change-operation-failed",
      run: ({ generation }) => service.snapshot(generation),
    }),
    router.register({
      channel: CHANGE_IPC_CHANNELS.scan,
      input: changeGenerationInputSchema,
      output: changeOperationResultSchema,
      failureCode: "change-operation-failed",
      run: ({ generation }, context) => service.scan(generation, { signal: context.signal }),
    }),
    router.register({
      channel: CHANGE_IPC_CHANNELS.updateSelection,
      input: changeSelectionInputSchema,
      output: changeOperationResultSchema,
      failureCode: "change-operation-failed",
      run: ({ generation, changeSetId, expectedRevision, selection }, context) => (
        service.updateSelection(generation, changeSetId, expectedRevision, selection, { signal: context.signal })
      ),
    }),
    router.register({
      channel: CHANGE_IPC_CHANNELS.prepareApply,
      input: changeSetMutationInputSchema,
      output: preparedApplyResultSchema,
      failureCode: "change-operation-failed",
      run: ({ generation, changeSetId, expectedRevision }, context) => (
        service.prepareApply(generation, changeSetId, expectedRevision, { signal: context.signal })
      ),
    }),
    router.register({
      channel: CHANGE_IPC_CHANNELS.commitApply,
      input: commitApplyInputSchema,
      output: changeOperationResultSchema,
      failureCode: "change-operation-failed",
      run: ({ generation, transactionId, planDigest }, context) => (
        service.commitApply(generation, transactionId, planDigest, { signal: context.signal })
      ),
    }),
    router.register({
      channel: CHANGE_IPC_CHANNELS.discard,
      input: discardInputSchema,
      output: changeOperationResultSchema,
      failureCode: "change-operation-failed",
      run: ({ generation, changeSetId, expectedRevision, confirmUnappliedLoss }, context) => (
        service.discard(generation, changeSetId, expectedRevision, confirmUnappliedLoss, { signal: context.signal })
      ),
    }),
    router.register({
      channel: CHANGE_IPC_CHANNELS.recover,
      input: recoverInputSchema,
      output: changeOperationResultSchema,
      failureCode: "change-operation-failed",
      run: ({ generation, transactionId, action }, context) => (
        service.recover(generation, transactionId, action, { signal: context.signal })
      ),
    }),
  ];

  const unsubscribe = service.subscribe((snapshot) => {
    router.publish(
      getWindow(),
      CHANGE_IPC_CHANNELS.snapshot,
      "changes.snapshot",
      changeWorkspaceSnapshotSchema,
      snapshot,
    );
  });

  return () => {
    unsubscribe();
    for (const dispose of disposeHandlers) dispose();
  };
}
