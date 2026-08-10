import { useCallback, useEffect, useReducer } from "react";
import type { ProjectManifest, ProjectPersonalState } from "@/project-contracts";
import type { ProjectLifecycleSnapshot, ProjectOperationResult } from "@/project-ipc";

interface State {
  snapshot: ProjectLifecycleSnapshot | null;
  busy: boolean;
  pendingOperations: number;
  error: string | null;
}

type Action =
  | { type: "snapshot"; snapshot: ProjectLifecycleSnapshot }
  | { type: "operation-started" }
  | { type: "operation-finished" }
  | { type: "error"; error: string | null };

function reducer(state: State, action: Action): State {
  if (action.type === "operation-started") {
    return { ...state, pendingOperations: state.pendingOperations + 1, busy: true };
  }
  if (action.type === "operation-finished") {
    const pendingOperations = Math.max(0, state.pendingOperations - 1);
    return { ...state, pendingOperations, busy: pendingOperations > 0 };
  }
  if (action.type === "error") return { ...state, error: action.error };
  if (state.snapshot && action.snapshot.revision < state.snapshot.revision) return state;
  return { ...state, snapshot: action.snapshot, error: null };
}

export function useProjects() {
  const [state, dispatch] = useReducer(reducer, {
    snapshot: null,
    busy: false,
    pendingOperations: 0,
    error: null,
  });
  const bridge = window.larger?.projects;

  useEffect(() => {
    if (!bridge) {
      dispatch({
        type: "snapshot",
        snapshot: { revision: 0, active: null, pending: null, transition: null, recentProjects: [], problem: null },
      });
      dispatch({ type: "error", error: "Project operations are available in the Larger desktop app." });
      return;
    }
    let disposed = false;
    const unsubscribe = bridge.onSnapshot((snapshot) => {
      if (!disposed) dispatch({ type: "snapshot", snapshot });
    });
    void bridge.getSnapshot().then((snapshot) => {
      if (!disposed) dispatch({ type: "snapshot", snapshot });
    }).catch((cause: unknown) => {
      if (!disposed) dispatch({ type: "error", error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);

  const run = useCallback(async (operation: () => Promise<ProjectOperationResult>) => {
    dispatch({ type: "operation-started" });
    try {
      const result = await operation();
      dispatch({ type: "snapshot", snapshot: result.snapshot });
      return result;
    } catch (cause) {
      dispatch({ type: "error", error: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally {
      dispatch({ type: "operation-finished" });
    }
  }, []);

  return {
    ...state,
    pickAndOpen: () => bridge ? run(() => bridge.pickAndOpen()) : Promise.resolve(null),
    openRecent: (instanceKey: string) => bridge ? run(() => bridge.openRecent(instanceKey)) : Promise.resolve(null),
    initialize: (generation: number, manifest: ProjectManifest) => bridge
      ? run(() => bridge.initialize(generation, manifest))
      : Promise.resolve(null),
    updateManifest: (generation: number, manifest: ProjectManifest) => bridge
      ? run(() => bridge.updateManifest(generation, manifest))
      : Promise.resolve(null),
    dismissPending: (generation: number) => bridge
      ? run(() => bridge.dismissPending(generation))
      : Promise.resolve(null),
    setTrust: (generation: number, decision: "trusted" | "denied") => bridge
      ? run(() => bridge.setTrust(generation, decision))
      : Promise.resolve(null),
    refresh: (generation: number) => bridge ? run(() => bridge.refresh(generation)) : Promise.resolve(null),
    close: (generation: number) => bridge ? run(() => bridge.close(generation)) : Promise.resolve(null),
    removeRecent: (instanceKey: string) => bridge ? run(() => bridge.removeRecent(instanceKey)) : Promise.resolve(null),
    updatePersonalState: (generation: number, personalState: ProjectPersonalState) => bridge
      ? run(() => bridge.updatePersonalState(generation, personalState))
      : Promise.resolve(null),
    prepareWorkspace: (generation: number) => bridge
      ? run(() => bridge.prepareWorkspace(generation))
      : Promise.resolve(null),
  };
}
