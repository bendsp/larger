export const RUNTIME_STATE_VERSION = 1 as const;

export type RuntimePhase =
  | "idle"
  | "recovering"
  | "preparing-workspace"
  | "preparing-dependencies"
  | "allocating-port"
  | "starting-target"
  | "waiting-target"
  | "starting-editor"
  | "verifying-editor"
  | "validating-attach"
  | "ready-managed"
  | "ready-attached"
  | "stopping"
  | "cancelling"
  | "cancelled"
  | "failed";

export type RuntimeOperationKind = "start" | "attach" | "discover" | "restart" | "stop" | "detach" | "cancel" | "recover";

export interface RuntimeOperation {
  readonly id: string;
  readonly kind: RuntimeOperationKind;
  readonly phase: RuntimePhase;
  readonly startedAt: string;
  readonly cancellable: boolean;
}

export interface RuntimeProcessIdentity {
  readonly pid: number;
  readonly executable: string;
  readonly startedAt: string;
  readonly processGroupId: number | null;
}

export interface RuntimeEndpoint {
  readonly origin: string;
  readonly route: string;
  readonly displayUrl: string;
  readonly portAllocation: {
    readonly preferred: number;
    readonly actual: number;
  } | null;
}

export interface RuntimeProfileSummary {
  readonly name: string;
  readonly command: readonly string[];
  readonly workingDirectory: string;
  readonly host: "127.0.0.1";
  readonly preferredPort: number;
  readonly readinessPath: string;
  readonly runtimeAdapter: string;
  readonly editorAdapter: string | null;
}

export interface RuntimeDiscoveryCandidate {
  readonly id: string;
  readonly url: string;
  readonly processId: number | null;
  readonly label: string;
}

export interface RuntimeDiscoveryResult {
  readonly requestId: string;
  readonly completedAt: string;
  readonly candidates: readonly RuntimeDiscoveryCandidate[];
}

export interface RuntimeSurface {
  readonly id: string;
  readonly editorAdapter: string | null;
  readonly preview: true;
  readonly writable: boolean;
}

interface RuntimeSessionBase {
  readonly id: string;
  readonly projectGeneration: number;
  readonly projectInstanceKey: string;
  readonly endpoint: RuntimeEndpoint;
  readonly surface: RuntimeSurface;
  readonly startedAt: string;
}

export interface ManagedRuntimeSession extends RuntimeSessionBase {
  readonly mode: "managed";
  readonly ownership: "larger";
  readonly profileName: string;
  readonly runtimeId: string;
  readonly baselineIdentity: string;
  readonly dependencyIdentity: string | null;
  readonly command: readonly string[];
  readonly target: RuntimeProcessIdentity;
  readonly editor: RuntimeProcessIdentity | null;
  readonly canStop: true;
  readonly canRestart: true;
}

export interface AttachedRuntimeSession extends RuntimeSessionBase {
  readonly mode: "attached";
  readonly ownership: "external";
  readonly profileName: null;
  readonly target: null;
  readonly editor: null;
  readonly canStop: false;
  readonly canRestart: false;
  readonly surface: RuntimeSurface & { readonly writable: false; readonly editorAdapter: null };
}

export type RuntimeSession = ManagedRuntimeSession | AttachedRuntimeSession;

export interface RuntimeLogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly source: "runtime" | "editor" | "system";
  readonly stream: "stdout" | "stderr" | "diagnostic";
  readonly message: string;
}

export interface RuntimeLogWindow {
  readonly entries: readonly RuntimeLogEntry[];
  readonly earliestId: number | null;
  readonly latestId: number | null;
  readonly retained: number;
  readonly limit: number;
  readonly truncated: boolean;
}

export interface RuntimeProblem {
  readonly code:
    | "no-active-project"
    | "project-not-trusted"
    | "stale-generation"
    | "stale-revision"
    | "profile-not-found"
    | "workspace-failed"
    | "dependencies-failed"
    | "unsupported-platform"
    | "unsupported-runtime"
    | "port-unavailable"
    | "readiness-failed"
    | "editor-security-failed"
    | "invalid-attach-url"
    | "ownership-unknown"
    | "not-owned"
    | "operation-conflict"
    | "internal";
  readonly message: string;
  readonly recoverable: boolean;
  readonly phase: RuntimePhase;
  readonly actions: readonly ("retry" | "stop" | "detach" | "open-settings")[];
}

export interface RuntimeWorkspaceSnapshot {
  readonly formatVersion: typeof RUNTIME_STATE_VERSION;
  readonly revision: number;
  readonly projectGeneration: number | null;
  readonly projectInstanceKey: string | null;
  readonly profiles: readonly RuntimeProfileSummary[];
  readonly phase: RuntimePhase;
  readonly operation: RuntimeOperation | null;
  readonly session: RuntimeSession | null;
  readonly discovery: RuntimeDiscoveryResult | null;
  readonly logWindow: RuntimeLogWindow;
  readonly problem: RuntimeProblem | null;
}

export type RuntimeOperationResult =
  | { readonly status: "completed"; readonly snapshot: RuntimeWorkspaceSnapshot }
  | { readonly status: "cancelled"; readonly snapshot: RuntimeWorkspaceSnapshot };
