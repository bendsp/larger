import type { ApplicationSnapshot } from "./application-contract";
import { desktopErrorSchema, type DesktopError } from "./protocol";

export interface ApplicationLifecycleState {
  readonly snapshot: ApplicationSnapshot | null;
  readonly problem: DesktopError | null;
  readonly operation: "idle" | "retrying" | "quitting";
}

export type ApplicationLifecycleAction =
  | { readonly type: "snapshot"; readonly snapshot: ApplicationSnapshot }
  | { readonly type: "problem"; readonly problem: DesktopError }
  | { readonly type: "operation"; readonly operation: ApplicationLifecycleState["operation"] };

export const initialApplicationLifecycleState: ApplicationLifecycleState = {
  snapshot: null,
  problem: null,
  operation: "idle",
};

export function applicationLifecycleReducer(
  state: ApplicationLifecycleState,
  action: ApplicationLifecycleAction,
): ApplicationLifecycleState {
  if (action.type === "operation") return { ...state, operation: action.operation };
  if (action.type === "problem") return { ...state, problem: action.problem };

  const current = state.snapshot;
  if (current && action.snapshot.bootId !== current.bootId) return state;
  if (current && action.snapshot.revision < current.revision) return state;
  return { ...state, snapshot: action.snapshot, problem: null };
}

export function normalizeDesktopProblem(cause: unknown): DesktopError {
  if (cause && typeof cause === "object") {
    const candidate = cause as Partial<DesktopError> & { message?: unknown };
    const parsed = desktopErrorSchema.safeParse({
      code: candidate.code,
      message: candidate.message,
      retryable: candidate.retryable,
      ...(candidate.details === undefined ? {} : { details: candidate.details }),
    });
    if (parsed.success) return parsed.data;
    if ("code" in candidate || "retryable" in candidate) {
      return {
        code: "contract-violation",
        message: "Desktop service returned an invalid error response.",
        retryable: false,
      };
    }
  }

  if (cause instanceof Error && cause.name === "ZodError") {
    return {
      code: "contract-violation",
      message: "Desktop service returned an invalid response.",
      retryable: false,
    };
  }

  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Desktop service operation failed.";
  return {
    code: "application-operation-failed",
    message: message.slice(0, 4096) || "Desktop service operation failed.",
    retryable: true,
  };
}

export function projectServiceAvailable(snapshot: ApplicationSnapshot): boolean {
  if (snapshot.phase !== "ready" && snapshot.phase !== "degraded") return false;
  const status = snapshot.services.projects.status;
  return status === "ready" || status === "degraded";
}

export function applicationProblem(snapshot: ApplicationSnapshot): DesktopError | null {
  if (snapshot.problem) return snapshot.problem;
  for (const status of Object.values(snapshot.services)) {
    if (status.problem) return status.problem;
  }
  return null;
}
