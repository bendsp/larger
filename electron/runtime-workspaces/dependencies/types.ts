export const DEPENDENCY_SNAPSHOT_FORMAT_VERSION = 1 as const;

export type DependencyManagerName = "npm" | "pnpm" | "yarn" | "bun";
export type SupportedDependencyManager = "npm" | "pnpm";

export interface DependencyRuntimeFingerprint {
  readonly name: "node";
  readonly version: string;
  readonly modulesAbi: string;
  readonly napi?: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly libc?: string;
}

export interface DependencyInputFile {
  readonly path: string;
  readonly mode: number;
  readonly size: number;
  readonly sha256: string;
}

export interface DependencySnapshotKey {
  readonly formatVersion: typeof DEPENDENCY_SNAPSHOT_FORMAT_VERSION;
  readonly packageManager: SupportedDependencyManager;
  readonly packageManagerVersion: string;
  readonly packageManagerExecutableSha256: string;
  readonly installRootRelativePath: string;
  readonly lockfilePath: string;
  readonly lockfileSha256: string;
  readonly installInputsSha256: string;
  readonly sourceBaselineIdentity: string;
  readonly runtime: DependencyRuntimeFingerprint;
  readonly installPolicySha256: string;
  readonly materializerVersion: string;
}

export type DependencySnapshotEntry =
  | {
      readonly path: string;
      readonly type: "directory";
      readonly mode: number;
    }
  | {
      readonly path: string;
      readonly type: "file";
      readonly mode: number;
      readonly size: number;
      readonly contentSha256: string;
    }
  | {
      readonly path: string;
      readonly type: "symlink";
      readonly mode: number;
      readonly target:
        | { readonly kind: "dependency-internal"; readonly relativeTarget: string }
        | { readonly kind: "runtime-workspace"; readonly runtimeRelativeTarget: string };
    };

export interface DependencySnapshotManifest {
  readonly formatVersion: typeof DEPENDENCY_SNAPSHOT_FORMAT_VERSION;
  readonly identity: string;
  readonly key: DependencySnapshotKey;
  readonly treeIdentity: string;
  readonly entries: readonly DependencySnapshotEntry[];
  readonly createdAt: string;
  readonly fileCount: number;
  readonly byteCount: number;
}

export interface ResolvedDependencyPlan {
  readonly identity: string;
  readonly key: DependencySnapshotKey;
  readonly managerExecutable: string;
  readonly installRootRelativePath: string;
  readonly inputFiles: readonly DependencyInputFile[];
}

export interface VerifiedDependencySnapshot {
  readonly identity: string;
  readonly path: string;
  readonly treePath: string;
  readonly manifest: DependencySnapshotManifest;
}

export type DependencyOperationPhase =
  | "planning"
  | "cache-hit"
  | "installing"
  | "sealing"
  | "publishing-snapshot"
  | "materializing"
  | "runtime-cache-hit"
  | "complete";

export interface DependencyOperationEvent {
  readonly operationId: string;
  readonly phase: DependencyOperationPhase;
  readonly snapshotIdentity?: string;
  readonly packageManager?: SupportedDependencyManager;
  readonly backend?: string;
  readonly cacheHit?: boolean;
}

export interface DependencyOperationOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: DependencyOperationEvent) => void | Promise<void>;
}

export interface DependencyPlanOptions extends DependencyOperationOptions {
  readonly workingDirectory?: string;
  readonly packageManager?: DependencyManagerName;
  readonly sourceBaselineIdentity?: string;
}

export interface RuntimeDependencyInstallation {
  readonly snapshotIdentity: string;
  readonly runtimeId: string;
  readonly nodeModulesPath: string;
  readonly backend: string;
  readonly reusedCurrent: boolean;
}

export interface DependencyInstallInvocation {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface DependencyInstaller {
  install(
    plan: ResolvedDependencyPlan,
    stagedProjectRoot: string,
    operationStagingPath: string,
    options?: DependencyOperationOptions,
  ): Promise<void>;
}
