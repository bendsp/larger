export const BASELINE_FORMAT_VERSION = 1 as const;

export type InventoryEntry =
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
      readonly target: string;
      readonly materializedTarget: string;
      readonly scope: "internal";
    };

export interface BaselineManifest {
  readonly formatVersion: typeof BASELINE_FORMAT_VERSION;
  readonly identity: string;
  readonly entries: readonly InventoryEntry[];
}

export interface CurrentWorkspace {
  readonly formatVersion: 1;
  readonly baselineIdentity: string;
  readonly runtimeId: string;
  readonly publishedAt: string;
}

export interface RuntimeWorkspace {
  readonly baselineIdentity: string;
  readonly baselinePath: string;
  readonly runtimeId: string;
  readonly runtimePath: string;
  readonly manifest: BaselineManifest;
}

export interface WorkspacePaths {
  readonly userDataPath: string;
  readonly storageRoot: string;
  readonly instanceRoot: string;
  readonly baselinesRoot: string;
  readonly runtimesRoot: string;
  readonly stagingRoot: string;
  readonly currentPointerPath: string;
}

export type StagingPhase =
  | "inventory-started"
  | "inventory-progress"
  | "inventory-complete"
  | "source-validated"
  | "baseline-prepared"
  | "baseline-installed"
  | "runtime-materialized"
  | "runtime-preparation-started"
  | "runtime-prepared"
  | "runtime-installed"
  | "before-publication";

export interface UnpublishedRuntimeWorkspace {
  readonly baselineIdentity: string;
  readonly baselinePath: string;
  readonly runtimeId: string;
  /**
   * A provider-owned staging path. Callers may prepare this tree, but must not
   * retain the path after the hook completes. The provider publishes or
   * removes it as one transaction.
   */
  readonly runtimePath: string;
  readonly manifest: BaselineManifest;
}

export interface StageWorkspaceOptions {
  readonly signal?: AbortSignal;
  readonly onPhase?: (phase: StagingPhase) => void | Promise<void>;
  readonly prepareRuntime?: (candidate: UnpublishedRuntimeWorkspace) => void | Promise<void>;
}

export interface MaterializationBackend {
  readonly name: string;
  materialize(
    baselineTreePath: string,
    destinationPath: string,
    manifest: BaselineManifest,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface DependencyCacheKey {
  readonly packageManager: "npm" | "pnpm" | "yarn" | "bun";
  readonly lockfileSha256: string;
  readonly runtime: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly toolchainVersion: string;
}

export interface DependencyCacheDescriptor {
  readonly identity: string;
  readonly key: DependencyCacheKey;
  readonly sharing: "immutable-read-only";
  readonly runtimeNodeModules: "private-writable";
}
