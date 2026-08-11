import { randomBytes, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectIdentity, RuntimeProfile } from "../../src/project-contracts.js";
import {
  RUNTIME_STATE_VERSION,
  type AttachedRuntimeSession,
  type ManagedRuntimeSession,
  type RuntimeOperation,
  type RuntimeOperationKind,
  type RuntimeOperationResult,
  type RuntimePhase,
  type RuntimeProblem,
  type RuntimeProfileSummary,
  type RuntimeSession,
  type RuntimeSurface,
  type RuntimeWorkspaceSnapshot,
} from "../../src/runtime-contracts.js";
import type { RuntimeWorkspaceAccess } from "../runtime-workspaces/registry.js";
import type { RuntimeWorkspace, UnpublishedRuntimeWorkspace } from "../runtime-workspaces/types.js";
import { EditorSecurityError, type EditorAdapter, type EditorAdapterRegistry, type StartedEditor } from "./editor-adapter.js";
import type { RuntimeEnvironmentBuilder } from "./environment.js";
import {
  attachedEndpoint,
  EmptyRuntimeDiscoveryProvider,
  parseLoopbackHttpUrl,
  type PortAllocator,
  type ReadinessProbe,
  type RuntimeDiscoveryProvider,
  RuntimeNetworkError,
  PortUnavailableError,
} from "./network.js";
import type { ProcessSupervisor, SupervisedProcess } from "./process-supervisor.js";
import { RedactingLogBuffer } from "./redacting-log-buffer.js";
import type { RuntimeAdapterRegistry, RuntimeLaunchPlan } from "./runtime-adapter.js";

export interface AuthorizedRuntimeProject {
  readonly identity: ProjectIdentity;
  readonly generation: number;
  readonly trusted: boolean;
  readonly profiles: Readonly<Record<string, RuntimeProfile>>;
}

export interface RuntimeProjectGateway {
  current(generation: number): AuthorizedRuntimeProject | undefined;
  adoptWorkspace(generation: number, instanceKey: string, workspace: RuntimeWorkspace): Promise<void>;
}

export interface RuntimeWorkspaceGateway {
  for(identity: ProjectIdentity): Pick<RuntimeWorkspaceAccess, "current" | "stage">;
}

export interface DependencyPreparationResult {
  readonly identity: string;
}

export interface RuntimeDependencyPreparer {
  createPreparation(input: {
    readonly project: AuthorizedRuntimeProject;
    readonly profile: RuntimeProfile;
    readonly signal: AbortSignal;
  }): Promise<{
    prepareRuntime(candidate: UnpublishedRuntimeWorkspace): Promise<DependencyPreparationResult | null>;
  }>;
  restoreCurrent(input: {
    readonly project: AuthorizedRuntimeProject;
    readonly profile: RuntimeProfile;
    readonly workspace: RuntimeWorkspace;
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly status: "restored"; readonly result: DependencyPreparationResult | null }
    | { readonly status: "missing" }
  >;
}

export class NoopRuntimeDependencyPreparer implements RuntimeDependencyPreparer {
  async createPreparation(input: { readonly signal: AbortSignal }): Promise<{
    prepareRuntime(candidate: UnpublishedRuntimeWorkspace): Promise<null>;
  }> {
    input.signal.throwIfAborted();
    return {
      async prepareRuntime(): Promise<null> {
        input.signal.throwIfAborted();
        return null;
      },
    };
  }

  async restoreCurrent(input: { readonly signal: AbortSignal }): Promise<{
    readonly status: "restored";
    readonly result: null;
  }> {
    input.signal.throwIfAborted();
    return { status: "restored", result: null };
  }
}

export interface RuntimeServiceOptions {
  readonly projects: RuntimeProjectGateway;
  readonly workspaces: RuntimeWorkspaceGateway;
  readonly dependencies?: RuntimeDependencyPreparer;
  readonly environment: RuntimeEnvironmentBuilder;
  readonly runtimeAdapters: RuntimeAdapterRegistry;
  readonly editorAdapters: EditorAdapterRegistry;
  readonly supervisor: ProcessSupervisor;
  readonly ports: PortAllocator;
  readonly readiness: ReadinessProbe;
  readonly discovery?: RuntimeDiscoveryProvider;
  readonly logs?: RedactingLogBuffer;
  readonly logPublishIntervalMs?: number;
  readonly now?: () => Date;
  readonly id?: () => string;
}

export interface RuntimeOperationOptions {
  readonly signal?: AbortSignal;
}

interface LiveSession {
  readonly public: RuntimeSession | null;
  readonly surfaceUrl: string;
  readonly target: SupervisedProcess | null;
  readonly editor: SupervisedProcess | null;
  readonly editorAdapter: EditorAdapter | null;
  readonly startedEditor: StartedEditor | null;
}

type ActiveLiveSession = LiveSession & { readonly public: RuntimeSession };

type Listener = (snapshot: RuntimeWorkspaceSnapshot) => void;

function profilesFor(project: AuthorizedRuntimeProject | undefined): RuntimeProfileSummary[] {
  if (!project) return [];
  return Object.entries(project.profiles).sort(([left], [right]) => left.localeCompare(right)).map(([name, profile]) => ({
    name,
    command: [...profile.command],
    workingDirectory: profile.workingDirectory,
    host: profile.host,
    preferredPort: profile.preferredPort,
    readinessPath: profile.readiness.path,
    runtimeAdapter: profile.runtimeAdapter,
    editorAdapter: profile.editorAdapter,
  }));
}

function problem(
  code: RuntimeProblem["code"],
  message: string,
  phase: RuntimePhase,
  actions: RuntimeProblem["actions"] = ["retry"],
): RuntimeProblem {
  return { code, message, recoverable: code !== "internal", phase, actions };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isAbort(cause: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (cause instanceof DOMException && cause.name === "AbortError");
}

async function resolveRuntimeDirectory(runtimePath: string, candidate: string): Promise<string> {
  const [canonicalRuntime, canonicalCandidate] = await Promise.all([realpath(runtimePath), realpath(candidate)]);
  const relative = path.relative(canonicalRuntime, canonicalCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The runtime working directory escapes its workspace.");
  }
  if (!(await stat(canonicalCandidate)).isDirectory()) {
    throw new Error("The runtime working directory is not a directory.");
  }
  return canonicalCandidate;
}

function validateLaunchPlan(
  plan: RuntimeLaunchPlan,
  expected: { readonly port: number; readonly cwd: string; readonly environment: Readonly<Record<string, string>> },
): void {
  const expectedOrigin = `http://127.0.0.1:${expected.port}`;
  const origin = parseLoopbackHttpUrl(plan.endpoint.origin);
  const display = parseLoopbackHttpUrl(plan.endpoint.displayUrl);
  const readiness = parseLoopbackHttpUrl(plan.readiness.url);
  if (
    plan.endpoint.origin !== expectedOrigin
    || origin.origin !== expectedOrigin
    || display.origin !== expectedOrigin
    || readiness.origin !== expectedOrigin
    || `${display.pathname}${display.search}` !== plan.endpoint.route
    || plan.endpoint.portAllocation?.actual !== expected.port
  ) {
    throw new Error("The runtime adapter returned an endpoint outside its allocated loopback origin.");
  }
  if (!Number.isFinite(plan.readiness.timeoutMs) || plan.readiness.timeoutMs <= 0) {
    throw new Error("The runtime adapter returned an invalid readiness timeout.");
  }
  if (!plan.spawn.command.trim() || plan.spawn.command.includes("\0") || plan.spawn.args.some((argument) => argument.includes("\0"))) {
    throw new Error("The runtime adapter returned an invalid command.");
  }
  const actualEnvironment = Object.entries(plan.spawn.environment).sort(([left], [right]) => left.localeCompare(right));
  const expectedEnvironment = Object.entries(expected.environment).sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(actualEnvironment) !== JSON.stringify(expectedEnvironment)) {
    throw new Error("The runtime adapter changed the approved process environment.");
  }
}

export class RuntimeService {
  private readonly dependencies: RuntimeDependencyPreparer;
  private readonly discoveryProvider: RuntimeDiscoveryProvider;
  private readonly logs: RedactingLogBuffer;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly logPublishIntervalMs: number;
  private readonly disposeLogSubscription: () => void;
  private readonly listeners = new Set<Listener>();
  private revision = 0;
  private state: RuntimeWorkspaceSnapshot;
  private operationController: AbortController | null = null;
  private operationTask: Promise<RuntimeOperationResult> | null = null;
  private live: LiveSession | null = null;
  private logPublishTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RuntimeServiceOptions) {
    this.dependencies = options.dependencies ?? new NoopRuntimeDependencyPreparer();
    this.discoveryProvider = options.discovery ?? new EmptyRuntimeDiscoveryProvider();
    this.logs = options.logs ?? new RedactingLogBuffer();
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.logPublishIntervalMs = options.logPublishIntervalMs ?? 50;
    if (!Number.isFinite(this.logPublishIntervalMs) || this.logPublishIntervalMs < 0) {
      throw new Error("Runtime log publication interval must be non-negative");
    }
    this.state = {
      formatVersion: RUNTIME_STATE_VERSION,
      revision: 0,
      projectGeneration: null,
      projectInstanceKey: null,
      profiles: [],
      phase: "idle",
      operation: null,
      session: null,
      discovery: null,
      logWindow: this.logs.window(),
      problem: null,
    };
    this.disposeLogSubscription = this.logs.subscribe(() => this.scheduleLogPublication());
  }

  snapshot(generation?: number): RuntimeWorkspaceSnapshot {
    if (generation !== undefined) this.synchronizeProject(generation);
    return structuredClone({ ...this.state, logWindow: this.logs.window() });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resolveSurface(generation: number, surfaceId: string): string | undefined {
    const live = this.live;
    const project = this.options.projects.current(generation);
    if (
      !live
      || !live.public
      || !project?.trusted
      || project.identity.instanceKey !== live.public.projectInstanceKey
      || live.public.projectGeneration !== generation
      || live.public.surface.id !== surfaceId
    ) return undefined;
    return live.surfaceUrl;
  }

  hasActiveRuntime(): boolean {
    return this.live !== null || this.state.operation !== null;
  }

  start(
    generation: number,
    profileName: string,
    expectedRevision: number,
    options: RuntimeOperationOptions = {},
  ): Promise<RuntimeOperationResult> {
    options.signal?.throwIfAborted();
    const operation = this.begin("start", "preparing-workspace", generation, expectedRevision);
    if (!operation) return Promise.resolve({ status: "completed", snapshot: this.snapshot() });
    return this.runOperation((signal) => this.startManaged(generation, profileName, signal), options.signal);
  }

  attach(generation: number, value: string, expectedRevision: number, options: RuntimeOperationOptions = {}): Promise<RuntimeOperationResult> {
    options.signal?.throwIfAborted();
    const operation = this.begin("attach", "validating-attach", generation, expectedRevision);
    if (!operation) return Promise.resolve({ status: "completed", snapshot: this.snapshot() });
    return this.runOperation((signal) => this.attachExternal(generation, value, signal), options.signal);
  }

  discover(generation: number, expectedRevision: number, options: RuntimeOperationOptions = {}): Promise<RuntimeOperationResult> {
    options.signal?.throwIfAborted();
    const operation = this.begin("discover", "validating-attach", generation, expectedRevision);
    if (!operation) return Promise.resolve({ status: "completed", snapshot: this.snapshot() });
    return this.runOperation(async (signal) => {
      this.requireAuthorized(generation);
      const candidates = (await this.discoveryProvider.discover(signal)).filter((candidate) => {
        try {
          parseLoopbackHttpUrl(candidate.url);
          return true;
        } catch {
          return false;
        }
      });
      this.update({
        discovery: { requestId: operation.id, completedAt: this.now().toISOString(), candidates },
        phase: this.live?.public?.mode === "managed" ? "ready-managed" : this.live?.public ? "ready-attached" : "idle",
      });
    }, options.signal);
  }

  stop(generation: number, sessionId: string, expectedRevision: number, options: RuntimeOperationOptions = {}): Promise<RuntimeOperationResult> {
    options.signal?.throwIfAborted();
    const active = this.validateSessionMutation(generation, sessionId, expectedRevision);
    if (!active) return Promise.resolve({ status: "completed", snapshot: this.snapshot() });
    if (active.public.mode === "attached") {
      this.fail(problem("not-owned", "Attached servers are external and cannot be stopped by Larger.", this.state.phase, ["detach"]));
      return Promise.resolve({ status: "completed", snapshot: this.snapshot() });
    }
    const operation = this.beginSessionOperation("stop", "stopping", generation, expectedRevision);
    if (!operation) return Promise.resolve({ status: "completed", snapshot: this.snapshot() });
    return this.runOperation(async (signal) => {
      await this.cleanupLive(signal);
      this.update({ phase: "idle" });
    }, options.signal);
  }

  detach(generation: number, sessionId: string, expectedRevision: number, options: RuntimeOperationOptions = {}): Promise<RuntimeOperationResult> {
    options.signal?.throwIfAborted();
    const active = this.validateSessionMutation(generation, sessionId, expectedRevision);
    if (!active) return Promise.resolve({ status: "completed", snapshot: this.snapshot() });
    if (active.public.mode !== "attached") {
      this.fail(problem("not-owned", "Managed runtimes must be stopped, not detached.", this.state.phase, ["stop"]));
      return Promise.resolve({ status: "completed", snapshot: this.snapshot() });
    }
    const operation = this.beginSessionOperation("detach", "stopping", generation, expectedRevision);
    if (!operation) return Promise.resolve({ status: "completed", snapshot: this.snapshot() });
    return this.runOperation(async (signal) => {
      signal.throwIfAborted();
      this.live = null;
      this.update({ session: null, phase: "idle" });
    }, options.signal);
  }

  restart(generation: number, sessionId: string, expectedRevision: number, options: RuntimeOperationOptions = {}): Promise<RuntimeOperationResult> {
    options.signal?.throwIfAborted();
    const active = this.validateSessionMutation(generation, sessionId, expectedRevision);
    if (!active) return Promise.resolve({ status: "completed", snapshot: this.snapshot() });
    if (active.public.mode !== "managed") {
      this.fail(problem("not-owned", "Attached servers cannot be restarted by Larger.", this.state.phase, ["detach"]));
      return Promise.resolve({ status: "completed", snapshot: this.snapshot() });
    }
    const profileName = active.public.profileName;
    const operation = this.beginSessionOperation("restart", "stopping", generation, expectedRevision);
    if (!operation) return Promise.resolve({ status: "completed", snapshot: this.snapshot() });
    return this.runOperation(async (signal) => {
      await this.cleanupLive(signal);
      await this.startManaged(generation, profileName, signal);
    }, options.signal);
  }

  async cancel(generation: number, operationId: string, options: RuntimeOperationOptions = {}): Promise<RuntimeOperationResult> {
    options.signal?.throwIfAborted();
    const project = this.options.projects.current(generation);
    if (!project || project.generation !== generation) {
      this.fail(problem("stale-generation", "The project generation is stale.", this.state.phase));
      return { status: "completed", snapshot: this.snapshot() };
    }
    if (
      !this.state.operation
      || this.state.operation.id !== operationId
      || !this.state.operation.cancellable
      || !this.operationController
      || !this.operationTask
    ) {
      this.fail(problem("operation-conflict", "That runtime operation is no longer active.", this.state.phase));
      return { status: "completed", snapshot: this.snapshot() };
    }
    this.setPhase("cancelling");
    this.operationController.abort(new DOMException("Runtime operation cancelled", "AbortError"));
    await this.operationTask;
    return { status: "cancelled", snapshot: this.snapshot() };
  }

  async recover(): Promise<RuntimeOperationResult> {
    if (this.operationTask) return { status: "completed", snapshot: this.snapshot() };
    this.beginUnbound("recover", "recovering");
    return this.runOperation(async (signal) => {
      const outcomes = await this.options.supervisor.recover(signal);
      const mismatch = outcomes.find((outcome) => outcome.status === "ownership-mismatch");
      if (mismatch) {
        throw problem("ownership-unknown", `Ownership could not be proven for ${mismatch.recordId}; no signal was sent.`, "recovering", ["open-settings"]);
      }
      this.update({ phase: "idle" });
    });
  }

  async stopForProjectSwitch(): Promise<void> {
    if (this.operationController && this.operationTask) {
      this.operationController.abort(new DOMException("Project switched", "AbortError"));
      await this.operationTask;
    }
    if (this.live) {
      this.setPhase("stopping");
      await this.cleanupLive();
      this.finish("idle");
    } else if (this.state.phase !== "idle") {
      this.finish("idle");
    }
  }

  async dispose(): Promise<void> {
    await this.stopForProjectSwitch();
    this.disposeLogSubscription();
    if (this.logPublishTimer) clearTimeout(this.logPublishTimer);
    this.logPublishTimer = null;
    this.listeners.clear();
  }

  private scheduleLogPublication(): void {
    if (this.logPublishTimer) return;
    this.logPublishTimer = setTimeout(() => {
      this.logPublishTimer = null;
      this.publish();
    }, this.logPublishIntervalMs);
    this.logPublishTimer.unref();
  }

  private async startManaged(generation: number, profileName: string, signal: AbortSignal): Promise<void> {
    if (!this.options.supervisor.managedLaunchSupported) {
      throw problem("unsupported-platform", "Managed runtimes are disabled until process-tree ownership is proven on this platform.", this.state.phase, ["open-settings"]);
    }
    let project = this.requireAuthorized(generation);
    const initialProfile = project.profiles[profileName];
    if (!initialProfile) throw problem("profile-not-found", `Runtime profile ${profileName} does not exist.`, this.state.phase, ["open-settings"]);
    const reviewedProject = structuredClone(project);
    const reviewedProfile = structuredClone(initialProfile);
    const profileFingerprint = JSON.stringify(reviewedProfile);

    const dependencyState: { identity: string | null } = { identity: null };
    this.setPhase("preparing-workspace");
    const workspaceAccess = this.options.workspaces.for(reviewedProject.identity);
    let workspace = await workspaceAccess.current();
    if (workspace) {
      this.setPhase("preparing-dependencies");
      const restored = await this.dependencies.restoreCurrent({
        project: reviewedProject,
        profile: reviewedProfile,
        workspace,
        signal,
      });
      if (restored.status === "restored") {
        dependencyState.identity = restored.result?.identity ?? null;
      } else {
        throw problem(
          "dependencies-failed",
          "The existing runtime's dependency state no longer matches its saved snapshot. Larger preserved the runtime and its edits; review or discard those changes before starting again.",
          this.state.phase,
          ["retry", "open-settings"],
        );
      }
    }
    if (!workspace) {
      workspace = await workspaceAccess.stage(reviewedProject.identity.canonicalPath, {
        signal,
        prepareRuntime: async (candidate) => {
          this.setPhase("preparing-dependencies");
          const dependencyPreparation = await this.dependencies.createPreparation({
            project: reviewedProject,
            profile: reviewedProfile,
            signal,
          });
          dependencyState.identity = (await dependencyPreparation.prepareRuntime(candidate))?.identity ?? null;
        },
      });
    }
    await this.options.projects.adoptWorkspace(generation, reviewedProject.identity.instanceKey, workspace);
    project = this.revalidate(reviewedProject, generation);
    this.assertProfileUnchanged(project.profiles[profileName], profileFingerprint);

    project = this.revalidate(project, generation);
    this.assertProfileUnchanged(project.profiles[profileName], profileFingerprint);

    const resolvedEnvironment = await this.options.environment.build(reviewedProfile.environment, signal);
    this.logs.addSecrets(resolvedEnvironment.secretValues);
    this.setPhase("allocating-port");
    const port = await this.options.ports.allocate(reviewedProfile.preferredPort, signal);
    project = this.revalidate(project, generation);
    this.assertProfileUnchanged(project.profiles[profileName], profileFingerprint);

    const runtimeAdapter = this.options.runtimeAdapters.get(reviewedProfile.runtimeAdapter);
    if (!runtimeAdapter) throw problem("unsupported-runtime", `Runtime adapter ${reviewedProfile.runtimeAdapter} is unavailable.`, this.state.phase, ["open-settings"]);
    let workingDirectory: string;
    try {
      workingDirectory = await resolveRuntimeDirectory(
        workspace.runtimePath,
        path.resolve(workspace.runtimePath, reviewedProfile.workingDirectory),
      );
    } catch (cause) {
      throw problem("unsupported-runtime", errorMessage(cause), this.state.phase, ["open-settings"]);
    }
    const plan = await runtimeAdapter.plan({
      profile: reviewedProfile,
      runtimePath: workspace.runtimePath,
      workingDirectory,
      port,
      environment: resolvedEnvironment.values,
      signal,
    });
    try {
      validateLaunchPlan(plan, { port, cwd: workingDirectory, environment: resolvedEnvironment.values });
      const adapterWorkingDirectory = await resolveRuntimeDirectory(workspace.runtimePath, plan.spawn.cwd);
      if (adapterWorkingDirectory !== workingDirectory) {
        throw new Error("The runtime adapter changed the reviewed working directory.");
      }
    } catch (cause) {
      throw problem("unsupported-runtime", errorMessage(cause), this.state.phase, ["open-settings"]);
    }
    project = this.revalidate(project, generation);
    this.assertProfileUnchanged(project.profiles[profileName], profileFingerprint);
    const sessionId = this.id();
    this.setPhase("starting-target");
    const target = await this.options.supervisor.spawn({
      sessionId,
      role: "runtime",
      projectInstanceKey: project.identity.instanceKey,
      projectGeneration: generation,
      runtimeId: workspace.runtimeId,
      runtimePath: workspace.runtimePath,
      spec: plan.spawn,
      logs: this.logs,
      signal,
    });
    this.live = {
      public: null,
      surfaceUrl: plan.endpoint.displayUrl,
      target,
      editor: null,
      editorAdapter: null,
      startedEditor: null,
    };
    try {
      this.setPhase("waiting-target");
      await Promise.race([
        this.options.readiness.wait({ ...plan.readiness, signal }),
        target.exit.then((exit) => { throw new Error(`Runtime exited before readiness (${exit.code ?? exit.signal ?? "unknown"}).`); }),
      ]);
      this.revalidate(project, generation);

      let editor: SupervisedProcess | null = null;
      let editorAdapter: EditorAdapter | null = null;
      let startedEditor: StartedEditor | null = null;
      let surface: RuntimeSurface = { id: this.id(), editorAdapter: null, preview: true, writable: false };
      let surfaceUrl = plan.endpoint.displayUrl;
      if (reviewedProfile.editorAdapter) {
        editorAdapter = this.options.editorAdapters.get(reviewedProfile.editorAdapter) ?? null;
        if (!editorAdapter) throw problem("unsupported-runtime", `Editor adapter ${reviewedProfile.editorAdapter} is unavailable.`, this.state.phase, ["open-settings"]);
        this.setPhase("starting-editor");
        startedEditor = await editorAdapter.start({
          sessionId,
          projectInstanceKey: project.identity.instanceKey,
          projectGeneration: generation,
          runtimeId: workspace.runtimeId,
          runtimePath: workspace.runtimePath,
          target: plan.endpoint,
          capability: randomBytes(32).toString("hex"),
          signal,
          supervisor: this.options.supervisor,
          logs: this.logs,
        });
        editor = startedEditor.process;
        this.setPhase("verifying-editor");
        await editorAdapter.verify(startedEditor, signal);
        surface = startedEditor.surface;
        surfaceUrl = parseLoopbackHttpUrl(editorAdapter.surfaceUrl(startedEditor)).toString();
      }
      this.revalidate(project, generation);
      const session: ManagedRuntimeSession = {
        id: sessionId,
        mode: "managed",
        ownership: "larger",
        projectGeneration: generation,
        projectInstanceKey: project.identity.instanceKey,
        profileName,
        runtimeId: workspace.runtimeId,
        baselineIdentity: workspace.baselineIdentity,
        dependencyIdentity: dependencyState.identity,
        command: [plan.spawn.command, ...plan.spawn.args],
        target: target.identity,
        editor: editor?.identity ?? null,
        endpoint: plan.endpoint,
        surface,
        startedAt: this.now().toISOString(),
        canStop: true,
        canRestart: true,
      };
      this.live = { public: session, surfaceUrl, target, editor, editorAdapter, startedEditor };
      this.update({ session, phase: "ready-managed", problem: null });
      this.observeExit(sessionId, target, "Runtime");
      if (editor) this.observeExit(sessionId, editor, "Editor");
    } catch (cause) {
      await this.cleanupLive();
      throw cause;
    }
  }

  private async attachExternal(generation: number, value: string, signal: AbortSignal): Promise<void> {
    const project = this.requireAuthorized(generation);
    let url: URL;
    try {
      url = parseLoopbackHttpUrl(value);
    } catch (cause) {
      throw problem("invalid-attach-url", errorMessage(cause), this.state.phase, ["retry"]);
    }
    await this.options.readiness.wait({ url: url.toString(), timeoutMs: 5_000, signal });
    this.revalidate(project, generation);
    const session: AttachedRuntimeSession = {
      id: this.id(),
      mode: "attached",
      ownership: "external",
      projectGeneration: generation,
      projectInstanceKey: project.identity.instanceKey,
      profileName: null,
      target: null,
      editor: null,
      endpoint: attachedEndpoint(url),
      surface: { id: this.id(), editorAdapter: null, preview: true, writable: false },
      startedAt: this.now().toISOString(),
      canStop: false,
      canRestart: false,
    };
    this.live = {
      public: session,
      surfaceUrl: session.endpoint.displayUrl,
      target: null,
      editor: null,
      editorAdapter: null,
      startedEditor: null,
    };
    this.update({ session, phase: "ready-attached", problem: null });
  }

  private observeExit(sessionId: string, child: SupervisedProcess, label: string): void {
    void child.exit.then(async (exit) => {
      if (this.live?.public?.id !== sessionId || this.state.phase === "stopping") return;
      this.logs.diagnostic(`${label} exited unexpectedly (${exit.code ?? exit.signal ?? "unknown"}).`);
      await this.cleanupLive().catch((cause) => this.logs.diagnostic(errorMessage(cause)));
      this.finish("failed", problem("internal", `${label} exited unexpectedly.`, "failed", ["retry"]));
    });
  }

  private async cleanupLive(signal?: AbortSignal): Promise<void> {
    const live = this.live;
    this.live = null;
    if (!live) {
      this.update({ session: null });
      return;
    }
    const failures: unknown[] = [];
    const stopSignal = signal ?? new AbortController().signal;
    if (live.editorAdapter && live.startedEditor) {
      try {
        await live.editorAdapter.stop?.(live.startedEditor, stopSignal);
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (live.editor) {
      try {
        await this.options.supervisor.stop(live.editor, signal);
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (live.target) {
      try {
        await this.options.supervisor.stop(live.target, signal);
      } catch (cause) {
        failures.push(cause);
      }
    }
    this.logs.flush();
    this.update({ session: null });
    if (failures.length > 0) throw new AggregateError(failures, "Runtime cleanup was incomplete");
  }

  private runOperation(
    run: (signal: AbortSignal) => Promise<void>,
    externalSignal?: AbortSignal,
  ): Promise<RuntimeOperationResult> {
    const controller = this.operationController;
    if (!controller) throw new Error("Runtime operation controller is unavailable");
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    const task = (async (): Promise<RuntimeOperationResult> => {
      try {
        signal.throwIfAborted();
        await run(signal);
        this.finish(this.state.phase === "cancelled" ? "cancelled" : this.state.phase);
        return { status: "completed", snapshot: this.snapshot() };
      } catch (cause) {
        if (isAbort(cause, signal)) {
          await this.cleanupLive().catch((cleanupCause) => this.logs.diagnostic(errorMessage(cleanupCause)));
          this.finish("cancelled");
          return { status: "cancelled", snapshot: this.snapshot() };
        }
        const runtimeProblem = this.asProblem(cause);
        await this.cleanupLive().catch((cleanupCause) => this.logs.diagnostic(errorMessage(cleanupCause)));
        this.finish("failed", runtimeProblem);
        return { status: "completed", snapshot: this.snapshot() };
      } finally {
        if (this.operationController === controller) this.operationController = null;
        this.operationTask = null;
      }
    })();
    this.operationTask = task;
    return task;
  }

  private begin(kind: RuntimeOperationKind, phase: RuntimePhase, generation: number, expectedRevision: number): RuntimeOperation | null {
    this.synchronizeProject(generation);
    if (this.state.operation || this.live) {
      this.fail(problem("operation-conflict", "Stop or detach the active runtime before starting another operation.", this.state.phase, ["stop", "detach"]));
      return null;
    }
    if (expectedRevision !== this.state.revision) {
      this.fail(problem("stale-revision", "Runtime state changed; refresh and try again.", this.state.phase));
      return null;
    }
    const project = this.options.projects.current(generation);
    if (!project || project.generation !== generation) {
      this.fail(problem("stale-generation", "The project generation is stale.", this.state.phase));
      return null;
    }
    if (!project.trusted) {
      this.fail(problem("project-not-trusted", "Trust this project before using its runtime.", this.state.phase, ["open-settings"]));
      return null;
    }
    return this.beginUnbound(kind, phase);
  }

  private beginSessionOperation(
    kind: RuntimeOperationKind,
    phase: RuntimePhase,
    generation: number,
    expectedRevision: number,
  ): RuntimeOperation | null {
    this.synchronizeProject(generation);
    if (this.state.operation) {
      this.fail(problem("operation-conflict", "Another runtime operation is active.", this.state.phase));
      return null;
    }
    if (expectedRevision !== this.state.revision) {
      this.fail(problem("stale-revision", "Runtime state changed; refresh and try again.", this.state.phase));
      return null;
    }
    const project = this.options.projects.current(generation);
    if (!project || project.generation !== generation || project.identity.instanceKey !== this.live?.public?.projectInstanceKey) {
      this.fail(problem("stale-generation", "The project generation is stale.", this.state.phase));
      return null;
    }
    return this.beginUnbound(kind, phase);
  }

  private beginUnbound(kind: RuntimeOperationKind, phase: RuntimePhase): RuntimeOperation {
    const operation: RuntimeOperation = {
      id: this.id(),
      kind,
      phase,
      startedAt: this.now().toISOString(),
      cancellable: kind !== "stop" && kind !== "detach",
    };
    this.operationController = new AbortController();
    this.update({ operation, phase, problem: null });
    return operation;
  }

  private validateSessionMutation(generation: number, sessionId: string, expectedRevision: number): ActiveLiveSession | null {
    this.synchronizeProject(generation);
    if (expectedRevision !== this.state.revision) {
      this.fail(problem("stale-revision", "Runtime state changed; refresh and try again.", this.state.phase));
      return null;
    }
    if (!this.live?.public || this.live.public.id !== sessionId) {
      this.fail(problem("operation-conflict", "That runtime session is no longer active.", this.state.phase));
      return null;
    }
    if (this.live.public.projectGeneration !== generation) {
      this.fail(problem("stale-generation", "The project generation is stale.", this.state.phase));
      return null;
    }
    return this.live as ActiveLiveSession;
  }

  private requireAuthorized(generation: number): AuthorizedRuntimeProject {
    const project = this.options.projects.current(generation);
    if (!project) throw problem("no-active-project", "No project is active.", this.state.phase, ["open-settings"]);
    if (project.generation !== generation) throw problem("stale-generation", "The project generation is stale.", this.state.phase);
    if (!project.trusted) throw problem("project-not-trusted", "Trust this project before using its runtime.", this.state.phase, ["open-settings"]);
    return project;
  }

  private revalidate(previous: AuthorizedRuntimeProject, generation: number): AuthorizedRuntimeProject {
    const current = this.requireAuthorized(generation);
    if (current.identity.instanceKey !== previous.identity.instanceKey) {
      throw problem("stale-generation", "The active project changed during runtime startup.", this.state.phase);
    }
    return current;
  }

  private assertProfileUnchanged(profile: RuntimeProfile | undefined, expectedFingerprint: string): void {
    if (!profile || JSON.stringify(profile) !== expectedFingerprint) {
      throw problem("stale-revision", "The runtime profile changed during startup.", this.state.phase, ["retry"]);
    }
  }

  private synchronizeProject(generation: number): void {
    const project = this.options.projects.current(generation);
    if (!project) return;
    const instanceKey = project.identity.instanceKey;
    const session = this.state.session;
    if (session && (
      session.projectGeneration !== project.generation
      || session.projectInstanceKey !== instanceKey
    )) return;
    const profiles = profilesFor(project);
    if (
      this.state.projectGeneration === project.generation
      && this.state.projectInstanceKey === instanceKey
      && JSON.stringify(this.state.profiles) === JSON.stringify(profiles)
    ) return;
    if (this.state.projectInstanceKey !== null && this.state.projectInstanceKey !== instanceKey) {
      this.logs.clear();
    }
    this.update({ projectGeneration: project.generation, projectInstanceKey: instanceKey, profiles });
  }

  private setPhase(phase: RuntimePhase): void {
    this.update({
      phase,
      operation: this.state.operation ? { ...this.state.operation, phase } : null,
    });
  }

  private finish(phase: RuntimePhase, runtimeProblem: RuntimeProblem | null = null): void {
    this.update({ phase, operation: null, problem: runtimeProblem });
  }

  private fail(runtimeProblem: RuntimeProblem): void {
    this.update({ problem: runtimeProblem });
  }

  private asProblem(cause: unknown): RuntimeProblem {
    if (cause && typeof cause === "object" && "code" in cause && "phase" in cause && "actions" in cause) {
      return cause as RuntimeProblem;
    }
    if (cause instanceof PortUnavailableError) {
      return problem("port-unavailable", this.logs.redactText(cause.message), this.state.phase, ["retry"]);
    }
    if (cause instanceof EditorSecurityError) {
      return problem("editor-security-failed", this.logs.redactText(cause.message), this.state.phase, ["retry", "open-settings"]);
    }
    if (cause instanceof RuntimeNetworkError || this.state.phase === "waiting-target" || this.state.phase === "validating-attach") {
      return problem("readiness-failed", this.logs.redactText(errorMessage(cause)), this.state.phase, ["retry"]);
    }
    if (this.state.phase === "preparing-workspace") {
      return problem("workspace-failed", this.logs.redactText(errorMessage(cause)), this.state.phase, ["retry"]);
    }
    if (this.state.phase === "preparing-dependencies") {
      return problem("dependencies-failed", this.logs.redactText(errorMessage(cause)), this.state.phase, ["retry", "open-settings"]);
    }
    if (this.state.phase === "starting-editor" || this.state.phase === "verifying-editor") {
      return problem("editor-security-failed", this.logs.redactText(errorMessage(cause)), this.state.phase, ["retry", "open-settings"]);
    }
    return problem("internal", this.logs.redactText(errorMessage(cause)), this.state.phase, ["retry", "open-settings"]);
  }

  private update(patch: Partial<RuntimeWorkspaceSnapshot>): void {
    this.state = {
      ...this.state,
      ...patch,
      revision: ++this.revision,
      logWindow: this.logs.window(),
    };
    this.publish();
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
