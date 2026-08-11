import path from "node:path";
import type {
  ApplicationState,
  ProjectIdentity,
  ProjectManifest,
  ProjectPersonalState,
  RecentProject,
} from "../../src/project-contracts.js";
import type {
  ActiveProject,
  PendingProject,
  ProjectLifecycleSnapshot,
  ProjectOperationResult,
  ProjectProblem,
} from "../../src/project-ipc.js";
import type { RuntimeWorkspace } from "../runtime-workspaces/types.js";
import type { ApplicationStateStore } from "../storage/application-state-store.js";
import type { ProjectTrustStore } from "./project-trust-store.js";
import { createProjectIdentity } from "./project-identity.js";
import { detectProject } from "./project-detector.js";
import {
  ProjectManifestValidationError,
  readProjectManifest,
} from "./project-manifest.js";
import {
  initializeProject,
  suggestProjectManifest,
  updateProjectManifest,
} from "./project-initializer.js";

export interface RuntimeWorkspaceGateway {
  stage(sourceRoot: string, options?: { signal?: AbortSignal }): Promise<RuntimeWorkspace>;
  current?(): Promise<RuntimeWorkspace | undefined>;
}

export interface SessionSwitchGuard {
  hasActiveSession(): boolean;
  stopForProjectSwitch(): Promise<void>;
}

export interface ProjectManagerDependencies {
  applicationState: ApplicationStateStore;
  trust: ProjectTrustStore;
  createWorkspace(identity: ProjectIdentity): RuntimeWorkspaceGateway;
  detect?: typeof detectProject;
  readManifest?: typeof readProjectManifest;
  initialize?: typeof initializeProject;
  updateManifest?: typeof updateProjectManifest;
  switchGuard?: SessionSwitchGuard;
  now?: () => Date;
}

class ProjectSwitchBlockedError extends Error {
  override readonly name = "ProjectSwitchBlockedError";
}

type SnapshotListener = (snapshot: ProjectLifecycleSnapshot) => void;

const NO_SESSION: SessionSwitchGuard = {
  hasActiveSession: () => false,
  stopForProjectSwitch: async () => undefined,
};

function operationCompleted(snapshot: ProjectLifecycleSnapshot): ProjectOperationResult {
  return { status: "completed", snapshot };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function problemFor(cause: unknown): ProjectProblem {
  if (cause instanceof ProjectManifestValidationError) {
    return {
      code: "invalid-manifest",
      message: "The project manifest needs attention.",
      recoverable: true,
      fieldErrors: cause.errors,
    };
  }
  const code = (cause as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return { code: "missing", message: "The project folder is no longer available.", recoverable: true };
  }
  return { code: "internal", message: errorMessage(cause), recoverable: true };
}

function publicWorkspace(workspace: RuntimeWorkspace, preparedAt: Date) {
  return {
    baselineIdentity: workspace.baselineIdentity,
    runtimeId: workspace.runtimeId,
    preparedAt: preparedAt.toISOString(),
  };
}

export class ProjectManager {
  private readonly applicationState: ApplicationStateStore;
  private readonly trust: ProjectTrustStore;
  private readonly createWorkspace: ProjectManagerDependencies["createWorkspace"];
  private readonly detect: typeof detectProject;
  private readonly readManifest: typeof readProjectManifest;
  private readonly initializeProject: typeof initializeProject;
  private readonly updateProjectManifest: typeof updateProjectManifest;
  private readonly switchGuard: SessionSwitchGuard;
  private readonly now: () => Date;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly workspaceGateways = new Map<string, RuntimeWorkspaceGateway>();
  private generation = 0;
  private revision = 0;
  private controller: AbortController | null = null;
  private suspendedActive: ActiveProject | null = null;
  private state: ProjectLifecycleSnapshot = {
    revision: 0,
    active: null,
    pending: null,
    transition: null,
    recentProjects: [],
    problem: null,
  };

  constructor(dependencies: ProjectManagerDependencies) {
    this.applicationState = dependencies.applicationState;
    this.trust = dependencies.trust;
    this.createWorkspace = dependencies.createWorkspace;
    this.detect = dependencies.detect ?? detectProject;
    this.readManifest = dependencies.readManifest ?? readProjectManifest;
    this.initializeProject = dependencies.initialize ?? initializeProject;
    this.updateProjectManifest = dependencies.updateManifest ?? updateProjectManifest;
    this.switchGuard = dependencies.switchGuard ?? NO_SESSION;
    this.now = dependencies.now ?? (() => new Date());
  }

  snapshot(): ProjectLifecycleSnapshot {
    return structuredClone(this.state);
  }

  activeForChanges(generation: number): ActiveProject {
    return structuredClone(this.requireActive(generation));
  }

  async authorizeSourceOperation(generation: number, expectedInstanceKey: string): Promise<ActiveProject> {
    const active = this.requireActive(generation);
    if (active.identity.instanceKey !== expectedInstanceKey) {
      throw new Error("The source operation belongs to a different project instance.");
    }
    const manifest = await this.readManifest(active.identity.canonicalPath);
    const identity = await createProjectIdentity(manifest.projectId, active.identity.canonicalPath);
    const current = this.requireActive(generation);
    if (
      identity.instanceKey !== expectedInstanceKey
      || identity.instanceKey !== current.identity.instanceKey
      || identity.projectId !== current.identity.projectId
    ) {
      throw new Error("Project identity changed before the source operation.");
    }
    return structuredClone({ ...current, manifest, identity });
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async bootstrap(): Promise<ProjectLifecycleSnapshot> {
    const applicationState = (await this.applicationState.read()).value;
    this.update({ recentProjects: applicationState.recentProjects, problem: null });
    const mostRecent = applicationState.recentProjects[0];
    if (mostRecent) await this.openPath(mostRecent.canonicalPath, mostRecent.instanceKey);
    return this.snapshot();
  }

  async openPath(projectPath: string, expectedInstanceKey?: string): Promise<ProjectOperationResult> {
    const { generation, signal } = this.begin("opening");
    try {
      const detection = await this.detect(projectPath, { signal });
      signal.throwIfAborted();
      let manifest: ProjectManifest;
      try {
        manifest = await this.readManifest(detection.canonicalPath);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
          if (cause instanceof ProjectManifestValidationError) {
            await this.commitPending({
              generation,
              canonicalPath: detection.canonicalPath,
              displayName: path.basename(detection.canonicalPath),
              reason: "invalid-manifest",
              detection,
              suggestedManifest: null,
              fieldErrors: cause.errors,
            }, problemFor(cause), signal);
            return operationCompleted(this.snapshot());
          }
          throw cause;
        }
        const monorepo = detection.monorepo.status === "deferred";
        const pending: PendingProject = {
          generation,
          canonicalPath: detection.canonicalPath,
          displayName: path.basename(detection.canonicalPath),
          reason: monorepo ? "unsupported-monorepo" : "needs-initialization",
          detection,
          suggestedManifest: monorepo ? null : suggestProjectManifest(detection.canonicalPath, detection),
          fieldErrors: [],
        };
        await this.commitPending(pending, monorepo ? {
          code: "unsupported",
          message: "Choose a package inside this workspace. Larger will not initialize the workspace root.",
          recoverable: true,
        } : null, signal);
        return operationCompleted(this.snapshot());
      }

      const identity = await createProjectIdentity(manifest.projectId, detection.canonicalPath);
      if (expectedInstanceKey && identity.instanceKey !== expectedInstanceKey) {
        throw new Error("This recent entry now points to a different project instance.");
      }
      signal.throwIfAborted();
      await this.ensureSafeSwitch();
      signal.throwIfAborted();
      const applicationState = (await this.applicationState.read()).value;
      const trustDecision = await this.trust.decisionFor(identity);
      const restoredWorkspace = await this.workspaceFor(identity).current?.();
      signal.throwIfAborted();
      if (!this.isCurrent(generation)) return { status: "cancelled", snapshot: this.snapshot() };
      const active: ActiveProject = {
        generation,
        manifest,
        identity,
        detection,
        trust: trustDecision ?? "undecided",
        personalState: applicationState.personalStateByInstance[identity.instanceKey] ?? {},
        workspace: restoredWorkspace ? publicWorkspace(restoredWorkspace, this.now()) : null,
      };
      this.update({
        active,
        pending: null,
        transition: null,
        recentProjects: applicationState.recentProjects,
        problem: null,
      });
      this.suspendedActive = null;
      const recordedState = await this.applicationState.recordRecent(identity, manifest.name, this.now(), { signal });
      if (this.isCurrent(generation) && this.state.active?.identity.instanceKey === identity.instanceKey) {
        this.update({ recentProjects: recordedState.recentProjects });
      }
      return operationCompleted(this.snapshot());
    } catch (cause) {
      if (signal.aborted || !this.isCurrent(generation)) {
        return { status: "cancelled", snapshot: this.snapshot() };
      }
      this.update({ transition: null, problem: cause instanceof ProjectSwitchBlockedError ? {
        code: "switch-blocked",
        message: cause.message,
        recoverable: true,
      } : problemFor(cause) });
      return operationCompleted(this.snapshot());
    }
  }

  async openRecent(instanceKey: string): Promise<ProjectOperationResult> {
    const recent = this.state.recentProjects.find((entry) => entry.instanceKey === instanceKey);
    if (!recent) {
      this.update({ problem: { code: "missing", message: "That recent project is no longer listed.", recoverable: true } });
      return operationCompleted(this.snapshot());
    }
    return this.openPath(recent.canonicalPath, recent.instanceKey);
  }

  async initialize(generation: number, manifestInput: unknown): Promise<ProjectOperationResult> {
    const pending = this.requirePending(generation);
    if (pending.reason === "unsupported-monorepo") {
      throw new Error("Workspace roots cannot be initialized until package selection is supported");
    }
    const transition = this.begin("initializing");
    try {
      await this.initializeProject(pending.canonicalPath, manifestInput, {
        signal: transition.signal,
        shouldPublish: () => this.isCurrent(transition.generation),
      });
      transition.signal.throwIfAborted();
      return this.openPath(pending.canonicalPath);
    } catch (cause) {
      if (transition.signal.aborted || !this.isCurrent(transition.generation)) {
        return { status: "cancelled", snapshot: this.snapshot() };
      }
      this.update({
        pending: { ...pending, generation: transition.generation },
        transition: null,
        problem: problemFor(cause),
      });
      return operationCompleted(this.snapshot());
    }
  }

  async setTrust(generation: number, decision: "trusted" | "denied"): Promise<ProjectOperationResult> {
    const active = this.requireActive(generation);
    if (decision === "denied") {
      const current = this.state.active;
      if (!current || current.identity.instanceKey !== active.identity.instanceKey) {
        return { status: "cancelled", snapshot: this.snapshot() };
      }
      this.update({ active: { ...current, trust: "denied" }, problem: null });

      // Revocation must survive a failed cleanup or an application crash. Keep the
      // in-memory denial fail-closed while the durable decision is published first.
      await this.trust.setDecision(active.identity, decision, this.now());
      const afterPersistence = this.state.active;
      if (!this.isCurrent(generation) || !afterPersistence || afterPersistence.identity.instanceKey !== active.identity.instanceKey) {
        return { status: "cancelled", snapshot: this.snapshot() };
      }

      await this.ensureSafeSwitch();
      const afterCleanup = this.state.active;
      if (!this.isCurrent(generation) || !afterCleanup || afterCleanup.identity.instanceKey !== active.identity.instanceKey) {
        return { status: "cancelled", snapshot: this.snapshot() };
      }
      return operationCompleted(this.snapshot());
    }
    await this.trust.setDecision(active.identity, decision, this.now());
    const current = this.state.active;
    if (!this.isCurrent(generation) || !current || current.identity.instanceKey !== active.identity.instanceKey) {
      return { status: "cancelled", snapshot: this.snapshot() };
    }
    if (current.trust !== decision) this.update({ active: { ...current, trust: decision }, problem: null });
    return operationCompleted(this.snapshot());
  }

  async updateManifest(generation: number, manifestInput: unknown): Promise<ProjectOperationResult> {
    const active = this.requireActive(generation);
    if (
      typeof manifestInput !== "object"
      || manifestInput === null
      || !("projectId" in manifestInput)
      || manifestInput.projectId !== active.identity.projectId
    ) {
      throw new Error("Project settings cannot change the stable project ID");
    }
    const transition = this.begin("opening");
    try {
      await this.updateProjectManifest(active.identity.canonicalPath, manifestInput, {
        signal: transition.signal,
        shouldPublish: () => this.isCurrent(transition.generation),
      });
      if (!this.isCurrent(transition.generation) || this.state.active?.identity.instanceKey !== active.identity.instanceKey) {
        return { status: "cancelled", snapshot: this.snapshot() };
      }
      return this.openPath(active.identity.canonicalPath, active.identity.instanceKey);
    } catch (cause) {
      if (transition.signal.aborted || !this.isCurrent(transition.generation)) {
        return { status: "cancelled", snapshot: this.snapshot() };
      }
      this.update({ transition: null, problem: problemFor(cause) });
      return operationCompleted(this.snapshot());
    }
  }

  async dismissPending(generation: number): Promise<ProjectOperationResult> {
    this.requirePending(generation);
    this.controller?.abort();
    this.controller = new AbortController();
    const restoredGeneration = ++this.generation;
    const restored = this.suspendedActive
      ? { ...this.suspendedActive, generation: restoredGeneration }
      : null;
    this.suspendedActive = null;
    this.update({ active: restored, pending: null, transition: null, problem: null });
    return operationCompleted(this.snapshot());
  }

  async refresh(generation: number): Promise<ProjectOperationResult> {
    const active = this.state.active?.generation === generation ? this.state.active : null;
    if (active) return this.openPath(active.identity.canonicalPath, active.identity.instanceKey);
    const pending = this.requirePending(generation);
    return this.openPath(pending.canonicalPath);
  }

  async close(generation: number): Promise<ProjectOperationResult> {
    this.requireActive(generation);
    const nextGeneration = this.begin("opening");
    try {
      await this.ensureSafeSwitch();
      nextGeneration.signal.throwIfAborted();
      if (this.isCurrent(nextGeneration.generation)) {
        this.update({ active: null, pending: null, transition: null, problem: null });
        this.suspendedActive = null;
      }
      return operationCompleted(this.snapshot());
    } catch (cause) {
      if (!nextGeneration.signal.aborted && this.isCurrent(nextGeneration.generation)) {
        this.update({ transition: null, problem: {
          code: "switch-blocked",
          message: errorMessage(cause),
          recoverable: true,
        } });
      }
      return operationCompleted(this.snapshot());
    }
  }

  async removeRecent(instanceKey: string): Promise<ProjectOperationResult> {
    const applicationState = await this.applicationState.removeRecent(instanceKey);
    this.update({ recentProjects: applicationState.recentProjects, problem: null });
    return operationCompleted(this.snapshot());
  }

  async updatePersonalState(
    generation: number,
    personalState: ProjectPersonalState,
  ): Promise<ProjectOperationResult> {
    const active = this.requireActive(generation);
    const applicationState = await this.applicationState.setPersonalState(active.identity.instanceKey, personalState);
    const current = this.state.active;
    if (!this.isCurrent(generation) || !current || current.identity.instanceKey !== active.identity.instanceKey) {
      return { status: "cancelled", snapshot: this.snapshot() };
    }
    const next = applicationState.personalStateByInstance[active.identity.instanceKey] ?? {};
    this.update({ active: { ...current, personalState: next }, problem: null });
    return operationCompleted(this.snapshot());
  }

  async prepareWorkspace(generation: number): Promise<ProjectOperationResult> {
    const active = this.requireActive(generation);
    if (active.trust !== "trusted") {
      this.update({ problem: { code: "not-trusted", message: "Trust this project before preparing its runtime workspace.", recoverable: true } });
      return operationCompleted(this.snapshot());
    }
    try {
      await this.ensureSafeSwitch();
    } catch (cause) {
      if (this.isCurrent(generation) && this.state.active?.identity.instanceKey === active.identity.instanceKey) {
        this.update({ problem: {
          code: "switch-blocked",
          message: errorMessage(cause),
          recoverable: true,
        } });
      }
      return operationCompleted(this.snapshot());
    }
    const afterCleanup = this.state.active;
    if (!this.isCurrent(generation) || !afterCleanup || afterCleanup.identity.instanceKey !== active.identity.instanceKey) {
      return { status: "cancelled", snapshot: this.snapshot() };
    }
    const transition = this.begin("preparing-workspace");
    try {
      const workspace = await this.workspaceFor(active.identity).stage(active.identity.canonicalPath, {
        signal: transition.signal,
      });
      transition.signal.throwIfAborted();
      if (this.isCurrent(transition.generation)) {
        const current = this.state.active;
        if (!current || current.identity.instanceKey !== active.identity.instanceKey) {
          return { status: "cancelled", snapshot: this.snapshot() };
        }
        this.update({
          active: { ...current, workspace: publicWorkspace(workspace, this.now()) },
          transition: null,
          problem: null,
        });
      }
      return operationCompleted(this.snapshot());
    } catch (cause) {
      if (transition.signal.aborted || !this.isCurrent(transition.generation)) {
        return { status: "cancelled", snapshot: this.snapshot() };
      }
      this.update({ transition: null, problem: {
        code: "workspace-failed",
        message: errorMessage(cause),
        recoverable: true,
      } });
      return operationCompleted(this.snapshot());
    }
  }

  async adoptPublishedWorkspace(
    generation: number,
    instanceKey: string,
    workspace: RuntimeWorkspace,
  ): Promise<void> {
    const active = this.requireActive(generation);
    if (active.identity.instanceKey !== instanceKey || active.trust !== "trusted") {
      throw new Error("The published runtime workspace is not authorized for the active project");
    }
    const published = await this.workspaceFor(active.identity).current?.();
    const current = this.requireActive(generation);
    if (
      current.identity.instanceKey !== instanceKey
      || current.trust !== "trusted"
      || !published
      || published.baselineIdentity !== workspace.baselineIdentity
      || published.runtimeId !== workspace.runtimeId
    ) {
      throw new Error("The runtime workspace publication is stale");
    }
    this.update({
      active: { ...current, workspace: publicWorkspace(published, this.now()) },
      problem: null,
    });
  }

  dispose(): void {
    this.controller?.abort();
    this.controller = null;
    this.suspendedActive = null;
    this.workspaceGateways.clear();
    this.listeners.clear();
  }

  private begin(kind: NonNullable<ProjectLifecycleSnapshot["transition"]>["kind"]): { generation: number; signal: AbortSignal } {
    this.controller?.abort();
    this.controller = new AbortController();
    const generation = ++this.generation;
    this.update({
      active: this.state.active ? { ...this.state.active, generation } : null,
      transition: { generation, kind },
      pending: this.state.pending ? { ...this.state.pending, generation } : null,
      problem: null,
    });
    return { generation, signal: this.controller.signal };
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private requireActive(generation: number): ActiveProject {
    const active = this.state.active;
    if (!active || active.generation !== generation) {
      throw new Error("The project generation is stale");
    }
    return active;
  }

  private requirePending(generation: number): PendingProject {
    const pending = this.state.pending;
    if (!pending || pending.generation !== generation) {
      throw new Error("The pending project generation is stale");
    }
    return pending;
  }

  private async ensureSafeSwitch(): Promise<void> {
    if (!this.switchGuard.hasActiveSession()) return;
    try {
      await this.switchGuard.stopForProjectSwitch();
    } catch (cause) {
      throw new ProjectSwitchBlockedError(errorMessage(cause));
    }
  }

  private async commitPending(
    pending: PendingProject,
    problem: ProjectProblem | null,
    signal: AbortSignal,
  ): Promise<void> {
    await this.ensureSafeSwitch();
    signal.throwIfAborted();
    if (!this.isCurrent(pending.generation)) return;
    const active = this.state.active;
    if (active) {
      const [applicationState, trustDecision] = await Promise.all([
        this.applicationState.read(),
        this.trust.decisionFor(active.identity),
      ]);
      signal.throwIfAborted();
      if (!this.isCurrent(pending.generation) || this.state.active?.identity.instanceKey !== active.identity.instanceKey) return;
      this.suspendedActive = {
        ...active,
        personalState: applicationState.value.personalStateByInstance[active.identity.instanceKey] ?? {},
        trust: trustDecision ?? active.trust,
      };
    }
    this.update({ active: null, pending, transition: null, problem });
  }

  private workspaceFor(identity: ProjectIdentity): RuntimeWorkspaceGateway {
    const existing = this.workspaceGateways.get(identity.instanceKey);
    if (existing) return existing;
    const created = this.createWorkspace(identity);
    this.workspaceGateways.set(identity.instanceKey, created);
    return created;
  }

  private update(patch: Partial<Omit<ProjectLifecycleSnapshot, "revision">>): void {
    this.state = { ...this.state, ...patch, revision: ++this.revision };
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function recentPath(recent: RecentProject): string {
  return recent.canonicalPath;
}

export function personalStateFor(applicationState: ApplicationState, identity: ProjectIdentity): ProjectPersonalState {
  return applicationState.personalStateByInstance[identity.instanceKey] ?? {};
}
