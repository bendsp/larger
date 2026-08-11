import { useCallback, useEffect, useReducer, useRef } from "react";
import type { LargerApplicationBridge } from "./application-contract";
import {
  applicationLifecycleReducer,
  initialApplicationLifecycleState,
  normalizeDesktopProblem,
} from "./application-state";

export function useApplicationLifecycle() {
  const bridge: LargerApplicationBridge | undefined = window.larger?.application;
  const [state, dispatch] = useReducer(applicationLifecycleReducer, initialApplicationLifecycleState);
  const operationPending = useRef(false);

  useEffect(() => {
    if (!bridge) {
      dispatch({
        type: "problem",
        problem: {
          code: "unavailable",
          message: "Desktop services are available in the Larger desktop app.",
          retryable: false,
        },
      });
      return;
    }

    let disposed = false;
    let unsubscribe: () => void = () => undefined;
    try {
      unsubscribe = bridge.onSnapshot((snapshot) => {
        if (!disposed) dispatch({ type: "snapshot", snapshot });
      });
    } catch (cause) {
      dispatch({ type: "problem", problem: normalizeDesktopProblem(cause) });
    }
    void (async () => {
      try {
        const snapshot = await bridge.getSnapshot();
        if (!disposed) dispatch({ type: "snapshot", snapshot });
      } catch (cause) {
        if (!disposed) dispatch({ type: "problem", problem: normalizeDesktopProblem(cause) });
      }
    })();

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);

  const retry = useCallback(async () => {
    if (!bridge || operationPending.current) return;
    operationPending.current = true;
    dispatch({ type: "operation", operation: "retrying" });
    try {
      const snapshot = await bridge.retry();
      dispatch({ type: "snapshot", snapshot });
    } catch (cause) {
      dispatch({ type: "problem", problem: normalizeDesktopProblem(cause) });
    } finally {
      operationPending.current = false;
      dispatch({ type: "operation", operation: "idle" });
    }
  }, [bridge]);

  const quit = useCallback(async () => {
    if (!bridge || operationPending.current) return;
    operationPending.current = true;
    dispatch({ type: "operation", operation: "quitting" });
    try {
      await bridge.quit();
    } catch (cause) {
      operationPending.current = false;
      dispatch({ type: "problem", problem: normalizeDesktopProblem(cause) });
      dispatch({ type: "operation", operation: "idle" });
    }
  }, [bridge]);

  return {
    ...state,
    bridgeAvailable: Boolean(bridge),
    busy: state.operation !== "idle",
    retry,
    quit,
  };
}

export type ApplicationLifecycleController = ReturnType<typeof useApplicationLifecycle>;
