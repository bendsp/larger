import { useCallback, useEffect, useReducer } from "react";
import type { RuntimeOperationResult, RuntimeWorkspaceSnapshot } from "@/runtime-contracts";

interface RuntimeState {
  readonly projectGeneration: number;
  readonly projectInstanceKey: string;
  readonly snapshot: RuntimeWorkspaceSnapshot | null;
  readonly hydrated: boolean;
  readonly pendingOperations: number;
  readonly pendingCalls: Readonly<Partial<Record<RuntimeCallKind, number>>>;
  readonly error: string | null;
}

type RuntimeCallKind = "start" | "attach" | "discover" | "cancel" | "stop" | "detach" | "restart";

type RuntimeAction =
  | { readonly type: "reset"; readonly projectGeneration: number; readonly projectInstanceKey: string }
  | { readonly type: "snapshot"; readonly snapshot: RuntimeWorkspaceSnapshot }
  | { readonly type: "started"; readonly projectGeneration: number; readonly projectInstanceKey: string; readonly kind: RuntimeCallKind }
  | { readonly type: "finished"; readonly projectGeneration: number; readonly projectInstanceKey: string; readonly kind: RuntimeCallKind }
  | { readonly type: "error"; readonly projectGeneration: number; readonly projectInstanceKey: string; readonly error: string };

function initialState(projectGeneration: number, projectInstanceKey: string): RuntimeState {
  return {
    projectGeneration,
    projectInstanceKey,
    snapshot: null,
    hydrated: false,
    pendingOperations: 0,
    pendingCalls: {},
    error: null,
  };
}

export function acceptsRuntimeSnapshot(
  state: Pick<RuntimeState, "projectGeneration" | "projectInstanceKey" | "snapshot">,
  snapshot: RuntimeWorkspaceSnapshot,
): boolean {
  if (
    snapshot.projectGeneration !== state.projectGeneration
    || snapshot.projectInstanceKey !== state.projectInstanceKey
  ) return false;
  if (!state.snapshot || snapshot.revision > state.snapshot.revision) return true;
  if (snapshot.revision !== state.snapshot.revision) return false;
  const currentLogId = state.snapshot.logWindow.latestId ?? 0;
  const candidateLogId = snapshot.logWindow.latestId ?? 0;
  return candidateLogId > currentLogId;
}

function reducer(state: RuntimeState, action: RuntimeAction): RuntimeState {
  if (action.type === "reset") return initialState(action.projectGeneration, action.projectInstanceKey);
  if (
    action.type !== "snapshot"
    && (
      action.projectGeneration !== state.projectGeneration
      || action.projectInstanceKey !== state.projectInstanceKey
    )
  ) return state;
  if (action.type === "started") return {
    ...state,
    pendingOperations: state.pendingOperations + 1,
    pendingCalls: { ...state.pendingCalls, [action.kind]: (state.pendingCalls[action.kind] ?? 0) + 1 },
    error: null,
  };
  if (action.type === "finished") return {
    ...state,
    pendingOperations: Math.max(0, state.pendingOperations - 1),
    pendingCalls: { ...state.pendingCalls, [action.kind]: Math.max(0, (state.pendingCalls[action.kind] ?? 0) - 1) },
  };
  if (action.type === "error") return { ...state, hydrated: true, error: action.error };
  if (!acceptsRuntimeSnapshot(state, action.snapshot)) return state;
  return { ...state, snapshot: action.snapshot, hydrated: true, error: null };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useRuntime(projectGeneration: number, projectInstanceKey: string) {
  const [state, dispatch] = useReducer(
    reducer,
    initialState(projectGeneration, projectInstanceKey),
  );
  const bridge = window.larger?.runtime;

  useEffect(() => {
    dispatch({ type: "reset", projectGeneration, projectInstanceKey });
    if (!bridge) {
      dispatch({
        type: "error",
        projectGeneration,
        projectInstanceKey,
        error: "Runtime controls are available in the Larger desktop app.",
      });
      return;
    }

    let disposed = false;
    const publish = (snapshot: RuntimeWorkspaceSnapshot) => {
      if (
        !disposed
        && snapshot.projectGeneration === projectGeneration
        && snapshot.projectInstanceKey === projectInstanceKey
      ) dispatch({ type: "snapshot", snapshot });
    };
    const unsubscribe = bridge.onSnapshot(publish);
    void bridge.getSnapshot(projectGeneration).then(publish).catch((cause: unknown) => {
      if (!disposed) dispatch({ type: "error", projectGeneration, projectInstanceKey, error: message(cause) });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge, projectGeneration, projectInstanceKey]);

  const run = useCallback(async (
    kind: RuntimeCallKind,
    operation: () => Promise<RuntimeOperationResult>,
  ): Promise<RuntimeOperationResult | null> => {
    dispatch({ type: "started", projectGeneration, projectInstanceKey, kind });
    try {
      const result = await operation();
      dispatch({ type: "snapshot", snapshot: result.snapshot });
      return result;
    } catch (cause) {
      dispatch({ type: "error", projectGeneration, projectInstanceKey, error: message(cause) });
      return null;
    } finally {
      dispatch({ type: "finished", projectGeneration, projectInstanceKey, kind });
    }
  }, [projectGeneration, projectInstanceKey]);

  const snapshot = state.snapshot;
  const operation = snapshot?.operation ?? null;
  const session = snapshot?.session ?? null;
  const expectedRevision = snapshot?.revision;
  const available = Boolean(bridge && snapshot);
  const invoke = (
    kind: RuntimeCallKind,
    operationFactory: (revision: number) => Promise<RuntimeOperationResult>,
  ): Promise<RuntimeOperationResult | null> => (
    bridge && expectedRevision !== undefined
      ? run(kind, () => operationFactory(expectedRevision))
      : Promise.resolve(null)
  );

  return {
    snapshot,
    session,
    operation,
    hydrated: state.hydrated,
    error: state.error,
    available,
    busy: state.pendingOperations > 0 || operation !== null,
    isPending: (kind: RuntimeCallKind) => (state.pendingCalls[kind] ?? 0) > 0,
    start: (profileName: string) => invoke("start", (revision) => (
      bridge!.start(projectGeneration, profileName, revision)
    )),
    attach: (url: string) => invoke("attach", (revision) => (
      bridge!.attach(projectGeneration, url, revision)
    )),
    discover: () => invoke("discover", (revision) => bridge!.discover(projectGeneration, revision)),
    cancel: (): Promise<RuntimeOperationResult | null> => (
      bridge && operation?.cancellable
        ? run("cancel", () => bridge.cancel(projectGeneration, operation.id))
        : Promise.resolve(null)
    ),
    stop: (): Promise<RuntimeOperationResult | null> => (
      session?.mode === "managed" && session.canStop
        ? invoke("stop", (revision) => bridge!.stop(projectGeneration, session.id, revision))
        : Promise.resolve(null)
    ),
    detach: (): Promise<RuntimeOperationResult | null> => (
      session?.mode === "attached"
        ? invoke("detach", (revision) => bridge!.detach(projectGeneration, session.id, revision))
        : Promise.resolve(null)
    ),
    restart: (): Promise<RuntimeOperationResult | null> => (
      session?.mode === "managed" && session.canRestart
        ? invoke("restart", (revision) => bridge!.restart(projectGeneration, session.id, revision))
        : Promise.resolve(null)
    ),
  };
}

export type RuntimeClient = ReturnType<typeof useRuntime>;
