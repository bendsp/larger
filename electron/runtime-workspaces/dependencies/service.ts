import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { captureInventory, validateSourceSnapshot } from "../inventory.js";
import type { UnpublishedRuntimeWorkspace } from "../types.js";
import { PackageManagerInstaller } from "./installer.js";
import { DependencyMaterializer } from "./materializer.js";
import { resolveDependencyPlan } from "./planner.js";
import { DependencySnapshotRepository } from "./snapshot-repository.js";
import { DirectDependencyCommandRunner, type DependencyCommandRunner } from "./process.js";
import type {
  DependencyInstaller,
  DependencyOperationEvent,
  DependencyOperationOptions,
  DependencyPlanOptions,
  ResolvedDependencyPlan,
  RuntimeDependencyInstallation,
} from "./types.js";

export interface DependencyServiceOptions {
  readonly userDataPath: string;
  readonly localInstanceKey: string;
  readonly installer?: DependencyInstaller;
  readonly materializer?: DependencyMaterializer;
  readonly commandRunner?: DependencyCommandRunner;
}

async function emit(
  event: DependencyOperationEvent,
  options: DependencyOperationOptions,
): Promise<void> {
  options.signal?.throwIfAborted();
  await options.onEvent?.(event);
  options.signal?.throwIfAborted();
}

export class DependencyService {
  private constructor(
    private readonly repository: DependencySnapshotRepository,
    private readonly installer: DependencyInstaller,
    private readonly materializer: DependencyMaterializer,
    private readonly commandRunner: DependencyCommandRunner,
  ) {}

  static async open(options: DependencyServiceOptions): Promise<DependencyService> {
    const commandRunner = options.commandRunner ?? new DirectDependencyCommandRunner();
    return new DependencyService(
      await DependencySnapshotRepository.open(options),
      options.installer ?? new PackageManagerInstaller(commandRunner),
      options.materializer ?? new DependencyMaterializer(),
      commandRunner,
    );
  }

  resolvePlan(runtimeRoot: string, options: DependencyPlanOptions = {}): Promise<ResolvedDependencyPlan> {
    return resolveDependencyPlan(runtimeRoot, options, this.commandRunner);
  }

  async prepareRuntime(
    candidate: UnpublishedRuntimeWorkspace,
    planOptions: DependencyPlanOptions = {},
  ): Promise<RuntimeDependencyInstallation> {
    const operationId = randomUUID();
    await emit({ operationId, phase: "planning" }, planOptions);
    const sourceBoundPlanOptions = {
      ...planOptions,
      sourceBaselineIdentity: candidate.baselineIdentity,
    };
    const plan = await this.resolvePlan(candidate.runtimePath, sourceBoundPlanOptions);
    const operationOptions: DependencyOperationOptions = {
      signal: planOptions.signal,
      onEvent: planOptions.onEvent,
    };
    const ensured = await this.repository.ensure(plan, async (operationStagingPath) => {
      await emit({
        operationId,
        phase: "installing",
        snapshotIdentity: plan.identity,
        packageManager: plan.key.packageManager,
        cacheHit: false,
      }, operationOptions);
      const stagedProjectRoot = path.join(operationStagingPath, "install-root");
      const snapshot = await captureInventory(candidate.runtimePath, stagedProjectRoot, operationOptions.signal);
      await validateSourceSnapshot(snapshot, operationOptions.signal);
      const stagedPlan = await resolveDependencyPlan(stagedProjectRoot, {
        workingDirectory: plan.installRootRelativePath,
        packageManager: plan.key.packageManager,
        sourceBaselineIdentity: candidate.baselineIdentity,
        signal: operationOptions.signal,
      }, this.commandRunner);
      if (stagedPlan.identity !== plan.identity) {
        throw new Error("Dependency inputs changed before the immutable installation could begin.");
      }
      await mkdir(path.join(operationStagingPath, "tmp"), { mode: 0o700 });
      await this.installer.install(plan, stagedProjectRoot, operationStagingPath, operationOptions);
      return {
        runtimeRoot: stagedProjectRoot,
        nodeModulesPath: path.join(
          plan.installRootRelativePath === "."
            ? stagedProjectRoot
            : path.join(stagedProjectRoot, ...plan.installRootRelativePath.split("/")),
          "node_modules",
        ),
      };
    }, operationOptions);
    await emit({
      operationId,
      phase: ensured.cacheHit ? "cache-hit" : "publishing-snapshot",
      snapshotIdentity: plan.identity,
      packageManager: plan.key.packageManager,
      cacheHit: ensured.cacheHit,
    }, operationOptions);
    const current = await this.materializer.current(
      ensured.snapshot,
      candidate.runtimePath,
      candidate.runtimeId,
      plan.installRootRelativePath,
    );
    if (current) {
      await emit({
        operationId,
        phase: "runtime-cache-hit",
        snapshotIdentity: plan.identity,
        packageManager: plan.key.packageManager,
        backend: current.backend,
        cacheHit: true,
      }, operationOptions);
      return current;
    }
    await emit({
      operationId,
      phase: "materializing",
      snapshotIdentity: plan.identity,
      packageManager: plan.key.packageManager,
      cacheHit: ensured.cacheHit,
    }, operationOptions);
    const installation = await this.materializer.materialize(
      ensured.snapshot,
      candidate.runtimePath,
      candidate.runtimeId,
      plan.installRootRelativePath,
      operationOptions,
    );
    await emit({
      operationId,
      phase: "complete",
      snapshotIdentity: plan.identity,
      packageManager: plan.key.packageManager,
      backend: installation.backend,
      cacheHit: ensured.cacheHit,
    }, operationOptions);
    return installation;
  }

  createPreparationHook(
    options: DependencyPlanOptions = {},
  ): (candidate: UnpublishedRuntimeWorkspace) => Promise<void> {
    return async (candidate) => {
      await this.prepareRuntime(candidate, options);
    };
  }

  async restoreCurrent(
    runtime: {
      readonly baselineIdentity: string;
      readonly runtimeId: string;
      readonly runtimePath: string;
    },
    planOptions: DependencyPlanOptions = {},
  ): Promise<RuntimeDependencyInstallation | null> {
    const plan = await this.resolvePlan(runtime.runtimePath, {
      ...planOptions,
      sourceBaselineIdentity: runtime.baselineIdentity,
    });
    const snapshot = await this.repository.load(plan.identity, planOptions.signal);
    if (!snapshot) return null;
    return this.materializer.current(
      snapshot,
      runtime.runtimePath,
      runtime.runtimeId,
      plan.installRootRelativePath,
    );
  }
}
