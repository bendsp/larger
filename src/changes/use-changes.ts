import { useCallback, useEffect, useReducer } from "react";
import type { ChangeSelection, ChangeSetSnapshot, RecoveryAction } from "@/change-contracts";
import type {
  ChangeOperationResult,
  ChangeWorkspaceSnapshot,
  PreparedApplyResult,
} from "@/change-ipc";
import type { ChangeWorkspaceOperation } from "./change-workspace";

interface State {
  readonly snapshot: ChangeWorkspaceSnapshot | null;
  readonly hydrated: boolean;
  readonly pendingOperations: number;
  readonly error: string | null;
}

type Action =
  | { readonly type: "snapshot"; readonly snapshot: ChangeWorkspaceSnapshot }
  | { readonly type: "started" }
  | { readonly type: "finished" }
  | { readonly type: "error"; readonly error: string | null };

function reducer(state: State, action: Action): State {
  if (action.type === "started") return { ...state, pendingOperations: state.pendingOperations + 1, error: null };
  if (action.type === "finished") return { ...state, pendingOperations: Math.max(0, state.pendingOperations - 1) };
  if (action.type === "error") return { ...state, hydrated: true, error: action.error };
  if (
    state.snapshot
    && state.snapshot.projectInstanceKey === action.snapshot.projectInstanceKey
    && state.snapshot.revision > action.snapshot.revision
  ) return state;
  return { ...state, snapshot: action.snapshot, hydrated: true, error: null };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useChanges(projectGeneration: number, projectInstanceKey: string) {
  const [state, dispatch] = useReducer(reducer, { snapshot: null, hydrated: false, pendingOperations: 0, error: null });
  const bridge = window.larger?.changes;

  useEffect(() => {
    if (!bridge) {
      dispatch({ type: "error", error: "Change review is available in the Larger desktop app." });
      return;
    }
    let disposed = false;
    const publish = (snapshot: ChangeWorkspaceSnapshot) => {
      if (
        !disposed
        && snapshot.projectGeneration === projectGeneration
        && snapshot.projectInstanceKey === projectInstanceKey
      ) dispatch({ type: "snapshot", snapshot });
    };
    const unsubscribe = bridge.onSnapshot(publish);
    void bridge.getSnapshot(projectGeneration).then(publish).catch((cause: unknown) => {
      if (!disposed) dispatch({ type: "error", error: message(cause) });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge, projectGeneration, projectInstanceKey]);

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T | null> => {
    dispatch({ type: "started" });
    try {
      const result = await operation();
      const snapshot = (result as { snapshot?: ChangeWorkspaceSnapshot }).snapshot;
      if (snapshot) dispatch({ type: "snapshot", snapshot });
      return result;
    } catch (cause) {
      dispatch({ type: "error", error: message(cause) });
      return null;
    } finally {
      dispatch({ type: "finished" });
    }
  }, []);

  const changeSet = state.snapshot?.changeSet ?? null;
  const operation: ChangeWorkspaceOperation = state.snapshot?.operation?.kind ?? "idle";
  const problem = state.snapshot?.problem?.message ?? state.error;
  return {
    snapshot: state.snapshot,
    hydrated: state.hydrated,
    changeSet,
    operation,
    problem,
    busy: state.pendingOperations > 0 || operation !== "idle",
    scan: (): Promise<ChangeOperationResult | null> => bridge
      ? run(() => bridge.scan(projectGeneration))
      : Promise.resolve(null),
    updateSelection: (next: ChangeSelection): Promise<ChangeOperationResult | null> => (
      bridge && changeSet
        ? run(() => bridge.updateSelection(projectGeneration, changeSet.id, changeSet.revision, next))
        : Promise.resolve(null)
    ),
    prepareApply: (snapshot: ChangeSetSnapshot): Promise<PreparedApplyResult | null> => bridge
      ? run(() => bridge.prepareApply(projectGeneration, snapshot.id, snapshot.revision))
      : Promise.resolve(null),
    commitApply: (prepared: PreparedApplyResult): Promise<ChangeOperationResult | null> => (
      bridge && prepared.transactionId && prepared.planDigest
        ? run(() => bridge.commitApply(projectGeneration, prepared.transactionId!, prepared.planDigest!))
        : Promise.resolve(null)
    ),
    cancelPrepared: (prepared: PreparedApplyResult): Promise<ChangeOperationResult | null> => (
      bridge && prepared.transactionId
        ? run(() => bridge.recover(projectGeneration, prepared.transactionId!, "roll-back"))
        : Promise.resolve(null)
    ),
    discard: (snapshot: ChangeSetSnapshot): Promise<ChangeOperationResult | null> => bridge
      ? run(() => bridge.discard(projectGeneration, snapshot.id, snapshot.revision, true))
      : Promise.resolve(null),
    recover: (snapshot: ChangeSetSnapshot, action: RecoveryAction): Promise<ChangeOperationResult | null> => (
      bridge && snapshot.recovery
        ? run(() => bridge.recover(projectGeneration, snapshot.recovery!.transactionId, action))
        : Promise.resolve(null)
    ),
  };
}
