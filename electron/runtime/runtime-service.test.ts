import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeProfile } from "../../src/project-contracts.js";
import type { RuntimeWorkspace } from "../runtime-workspaces/types.js";
import { StaticEditorAdapterRegistry, type EditorAdapter } from "./editor-adapter.js";
import { RuntimeEnvironmentBuilder } from "./environment.js";
import type {
  ProcessExit,
  ProcessSupervisor,
  SpawnSupervisedProcessInput,
  SupervisedProcess,
} from "./process-supervisor.js";
import { RuntimeService, type AuthorizedRuntimeProject, type RuntimeServiceOptions } from "./runtime-service.js";
import { CommandRuntimeAdapter, StaticRuntimeAdapterRegistry } from "./runtime-adapter.js";
import { runtimeWorkspaceSnapshotSchema } from "../../src/runtime-ipc.js";
import { RedactingLogBuffer } from "./redacting-log-buffer.js";

const profile: RuntimeProfile = {
  command: ["pnpm", "dev", "--host", "{host}", "--port", "{port}"],
  workingDirectory: ".",
  dependencyRoot: ".",
  host: "127.0.0.1",
  preferredPort: 4310,
  readiness: { path: "/", timeoutMs: 5_000 },
  entryRoute: "/",
  environment: { literals: {}, inherit: [], secrets: {} },
  runtimeAdapter: "command",
  editorAdapter: null,
};

function project(trusted = true): AuthorizedRuntimeProject {
  return {
    identity: { projectId: "project", instanceKey: "instance", canonicalPath: "/tmp/project" },
    generation: 1,
    trusted,
    profiles: { default: profile },
  };
}

function ids(): () => string {
  let value = 1;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

function rejectOnAbort<T>(signal: AbortSignal): Promise<T> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function waitForPhase(service: RuntimeService, phase: string): Promise<string> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const snapshot = service.snapshot();
    if (snapshot.phase === phase) return snapshot.operation!.id;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Runtime did not reach ${phase}; current phase is ${service.snapshot().phase}.`);
}

function options(overrides: Partial<RuntimeServiceOptions> = {}): RuntimeServiceOptions {
  const supervisor: ProcessSupervisor = {
    managedLaunchSupported: false,
    spawn: async () => { throw new Error("not reached"); },
    stop: async () => undefined,
    recover: async () => [],
  };
  return {
    projects: { current: () => project(), adoptWorkspace: async () => undefined },
    workspaces: { for: () => ({
      current: async () => undefined,
      stage: async () => { throw new Error("not reached"); },
    }) },
    environment: new RuntimeEnvironmentBuilder({ platform: "darwin", get: () => undefined }, { resolve: async () => "secret" }),
    runtimeAdapters: new StaticRuntimeAdapterRegistry([]),
    editorAdapters: new StaticEditorAdapterRegistry([]),
    supervisor,
    ports: { allocate: async () => 4310 },
    readiness: { wait: async () => undefined },
    id: ids(),
    ...overrides,
  };
}

test("attached sessions are preview-only and stop never touches the external process", async () => {
  let stopCalls = 0;
  const service = new RuntimeService(options({
    supervisor: {
      managedLaunchSupported: false,
      spawn: async () => { throw new Error("not reached"); },
      stop: async () => { stopCalls += 1; },
      recover: async () => [],
    },
  }));
  const initial = service.snapshot(1);
  const attached = await service.attach(1, "http://127.0.0.1:5173/path", initial.revision);
  assert.equal(attached.snapshot.phase, "ready-attached");
  assert.equal(attached.snapshot.session?.mode, "attached");
  assert.equal(attached.snapshot.session?.surface.writable, false);
  assert.equal(attached.snapshot.session?.canStop, false);
  assert.equal(
    service.resolveSurface(1, attached.snapshot.session!.surface.id),
    "http://127.0.0.1:5173/path",
  );
  assert.equal(service.resolveSurface(2, attached.snapshot.session!.surface.id), undefined);

  const stopped = await service.stop(1, attached.snapshot.session!.id, attached.snapshot.revision);
  assert.equal(stopped.snapshot.problem?.code, "not-owned");
  assert.equal(stopped.snapshot.session?.mode, "attached");
  assert.equal(stopCalls, 0);

  const detached = await service.detach(1, attached.snapshot.session!.id, stopped.snapshot.revision);
  assert.equal(detached.snapshot.phase, "idle");
  assert.equal(detached.snapshot.session, null);
  assert.equal(stopCalls, 0);
  assert.equal(service.resolveSurface(1, attached.snapshot.session!.surface.id), undefined);
});
test("project generation changes keep live snapshots valid and clear logs only after cleanup", async () => {
  let active = project();
  let projectTransition = false;
  const logs = new RedactingLogBuffer({ now: () => new Date("2026-08-11T00:00:00.000Z") });
  const service = new RuntimeService(options({
    projects: {
      current: (generation) => !projectTransition && generation === active.generation ? active : undefined,
      adoptWorkspace: async () => undefined,
    },
    logs,
  }));
  const initial = service.snapshot(1);
  await service.attach(1, "http://127.0.0.1:5173/", initial.revision);
  logs.addSecrets(["project-a-secret"]);
  logs.diagnostic("project-a-secret");
  active = {
    ...project(),
    identity: { ...project().identity, instanceKey: "other-instance", canonicalPath: "/tmp/other-project" },
    generation: 2,
  };

  const transitioning = service.snapshot(2);
  assert.equal(transitioning.projectGeneration, 1);
  assert.equal(transitioning.session?.projectGeneration, 1);
  assert.equal(runtimeWorkspaceSnapshotSchema.safeParse(transitioning).success, true);
  assert.equal(service.snapshot(999).projectGeneration, 1);

  projectTransition = true;
  await service.stopForProjectSwitch();
  assert.equal(service.snapshot(2).projectGeneration, 1);
  projectTransition = false;
  const switched = service.snapshot(2);
  assert.equal(switched.projectGeneration, 2);
  assert.equal(switched.projectInstanceKey, "other-instance");
  assert.equal(switched.session, null);
  assert.equal(switched.logWindow.retained, 0);
  logs.diagnostic("project-a-secret");
  assert.equal(service.snapshot().logWindow.entries.at(-1)?.message, "project-a-secret");
  assert.equal(runtimeWorkspaceSnapshotSchema.safeParse(service.snapshot()).success, true);
});

test("cancellation propagates through attach readiness and reaches a terminal state", async () => {
  const service = new RuntimeService(options({
    readiness: {
      wait: async ({ signal }) => await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        void resolve;
      }),
    },
  }));
  const initial = service.snapshot(1);
  const attaching = service.attach(1, "http://127.0.0.1:5173", initial.revision);
  const operationId = service.snapshot().operation!.id;
  const cancelled = await service.cancel(1, operationId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.snapshot.phase, "cancelled");
  assert.equal(cancelled.snapshot.session, null);
  assert.equal((await attaching).status, "cancelled");
});

test("managed cancellation is terminal across workspace, dependency, target, readiness, and editor phases", async (t) => {
  const workspace: RuntimeWorkspace = {
    baselineIdentity: "baseline",
    baselinePath: "/tmp/baseline",
    runtimeId: "runtime",
    runtimePath: "/tmp",
    manifest: { formatVersion: 1, identity: "baseline", entries: [] },
  };
  const pendingExit = new Promise<ProcessExit>(() => undefined);
  const child = (role: "runtime" | "editor"): SupervisedProcess => ({
    role,
    identity: {
      pid: role === "runtime" ? 101 : 102,
      executable: "/usr/bin/node",
      startedAt: "2026-08-11T00:00:00.000Z",
      processGroupId: role === "runtime" ? 101 : 102,
    },
    exit: pendingExit,
  });

  type PhaseFixture = {
    readonly name: string;
    readonly phase: string;
    readonly makeOptions: (stops: string[]) => Partial<RuntimeServiceOptions>;
  };
  const fixtures: readonly PhaseFixture[] = [
    {
      name: "workspace materialization",
      phase: "preparing-workspace",
      makeOptions: () => ({
        workspaces: { for: () => ({
          current: async () => undefined,
          stage: async (_source, stageOptions) => rejectOnAbort(stageOptions!.signal!),
        }) },
        supervisor: {
          managedLaunchSupported: true,
          spawn: async () => { throw new Error("not reached"); },
          stop: async () => undefined,
          recover: async () => [],
        },
      }),
    },
    {
      name: "dependency preparation",
      phase: "preparing-dependencies",
      makeOptions: () => ({
        workspaces: { for: () => ({
          current: async () => undefined,
          stage: async (_source, stageOptions) => {
            await stageOptions!.prepareRuntime!(workspace);
            return workspace;
          },
        }) },
        dependencies: {
          async createPreparation({ signal }) {
            return { prepareRuntime: async () => rejectOnAbort(signal) };
          },
          async restoreCurrent() { return { status: "missing" }; },
        },
        supervisor: {
          managedLaunchSupported: true,
          spawn: async () => { throw new Error("not reached"); },
          stop: async () => undefined,
          recover: async () => [],
        },
      }),
    },
    {
      name: "target startup",
      phase: "starting-target",
      makeOptions: () => ({
        workspaces: { for: () => ({ current: async () => workspace, stage: async () => workspace }) },
        dependencies: {
          async createPreparation() { throw new Error("not reached"); },
          async restoreCurrent() { return { status: "restored", result: null }; },
        },
        runtimeAdapters: new StaticRuntimeAdapterRegistry([new CommandRuntimeAdapter()]),
        supervisor: {
          managedLaunchSupported: true,
          spawn: async ({ signal }) => rejectOnAbort(signal),
          stop: async () => undefined,
          recover: async () => [],
        },
      }),
    },
    {
      name: "target readiness",
      phase: "waiting-target",
      makeOptions: (stops) => ({
        workspaces: { for: () => ({ current: async () => workspace, stage: async () => workspace }) },
        dependencies: {
          async createPreparation() { throw new Error("not reached"); },
          async restoreCurrent() { return { status: "restored", result: null }; },
        },
        runtimeAdapters: new StaticRuntimeAdapterRegistry([new CommandRuntimeAdapter()]),
        supervisor: {
          managedLaunchSupported: true,
          spawn: async () => child("runtime"),
          stop: async (process) => { stops.push(process.role); },
          recover: async () => [],
        },
        readiness: { wait: async ({ signal }) => rejectOnAbort(signal) },
      }),
    },
    {
      name: "editor attachment",
      phase: "starting-editor",
      makeOptions: (stops) => {
        const editorProfile: RuntimeProfile = { ...profile, editorAdapter: "fixture-editor" };
        const editor: EditorAdapter = {
          id: "fixture-editor",
          start: async ({ signal }) => rejectOnAbort(signal),
          verify: async () => undefined,
          surfaceUrl: () => "http://127.0.0.1:4311/",
        };
        return {
          projects: {
            current: () => ({ ...project(), profiles: { default: editorProfile } }),
            adoptWorkspace: async () => undefined,
          },
          workspaces: { for: () => ({ current: async () => workspace, stage: async () => workspace }) },
          dependencies: {
            async createPreparation() { throw new Error("not reached"); },
            async restoreCurrent() { return { status: "restored", result: null }; },
          },
          runtimeAdapters: new StaticRuntimeAdapterRegistry([new CommandRuntimeAdapter()]),
          editorAdapters: new StaticEditorAdapterRegistry([editor]),
          supervisor: {
            managedLaunchSupported: true,
            spawn: async () => child("runtime"),
            stop: async (process) => { stops.push(process.role); },
            recover: async () => [],
          },
        };
      },
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const stops: string[] = [];
      const service = new RuntimeService(options(fixture.makeOptions(stops)));
      const start = service.start(1, "default", service.snapshot(1).revision);
      const operationId = await waitForPhase(service, fixture.phase);
      const cancelled = await service.cancel(1, operationId);

      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.snapshot.phase, "cancelled");
      assert.equal(cancelled.snapshot.session, null);
      assert.equal(cancelled.snapshot.operation, null);
      assert.equal((await start).status, "cancelled");
      assert.deepEqual(stops, fixture.phase === "waiting-target" || fixture.phase === "starting-editor" ? ["runtime"] : []);
    });
  }
});

test("managed start fails closed when the platform supervisor is unavailable", async () => {
  const service = new RuntimeService(options());
  const initial = service.snapshot(1);
  const result = await service.start(1, "default", initial.revision);
  assert.equal(result.snapshot.phase, "failed");
  assert.equal(result.snapshot.problem?.code, "unsupported-platform");
});

test("untrusted projects cannot attach or launch", async () => {
  const service = new RuntimeService(options({
    projects: { current: () => project(false), adoptWorkspace: async () => undefined },
  }));
  const initial = service.snapshot(1);
  const result = await service.attach(1, "http://127.0.0.1:5173", initial.revision);
  assert.equal(result.snapshot.problem?.code, "project-not-trusted");
  assert.equal(result.snapshot.session, null);
});

test("managed state reaches ready only after workspace, environment, spawn, and readiness", async () => {
  const workspace: RuntimeWorkspace = {
    baselineIdentity: "baseline",
    baselinePath: "/tmp/baseline",
    runtimeId: "runtime",
    runtimePath: "/tmp",
    manifest: { formatVersion: 1, identity: "baseline", entries: [] },
  };
  let resolveExit: (exit: ProcessExit) => void = () => undefined;
  const exit = new Promise<ProcessExit>((resolve) => { resolveExit = resolve; });
  let adopted = false;
  let stopCalls = 0;
  let spawnedCommand: readonly string[] = [];
  let runtimeLogs: SpawnSupervisedProcessInput["logs"] | null = null;
  const supervisor: ProcessSupervisor = {
    managedLaunchSupported: true,
    async spawn(input): Promise<SupervisedProcess> {
      assert.equal(adopted, true);
      spawnedCommand = [input.spec.command, ...input.spec.args];
      runtimeLogs = input.logs;
      return {
        role: input.role,
        identity: {
          pid: 123,
          executable: "/usr/bin/node",
          startedAt: "2026-08-11T00:00:00.000Z",
          processGroupId: 123,
        },
        exit,
      };
    },
    async stop() {
      stopCalls += 1;
      resolveExit({ code: 0, signal: null });
    },
    recover: async () => [],
  };
  const service = new RuntimeService(options({
    projects: {
      current: () => project(),
      async adoptWorkspace(_generation, instanceKey, adoptedWorkspace) {
        assert.equal(instanceKey, "instance");
        assert.equal(adoptedWorkspace, workspace);
        adopted = true;
      },
    },
    workspaces: { for: () => ({
      current: async () => undefined,
      stage: async (_source, stageOptions) => {
        await stageOptions?.prepareRuntime?.(workspace);
        return workspace;
      },
    }) },
    runtimeAdapters: new StaticRuntimeAdapterRegistry([new CommandRuntimeAdapter()]),
    supervisor,
    logPublishIntervalMs: 0,
  }));
  const initial = service.snapshot(1);
  const started = await service.start(1, "default", initial.revision);
  assert.equal(started.snapshot.phase, "ready-managed");
  assert.equal(started.snapshot.session?.mode, "managed");
  assert.deepEqual(spawnedCommand, ["pnpm", "dev", "--host", "127.0.0.1", "--port", "4310"]);
  assert.deepEqual(started.snapshot.session?.endpoint.portAllocation, { preferred: 4310, actual: 4310 });
  assert.equal(service.resolveSurface(1, started.snapshot.session!.surface.id), "http://127.0.0.1:4310/");
  const publishedLogs: string[][] = [];
  const unsubscribe = service.subscribe((snapshot) => {
    publishedLogs.push(snapshot.logWindow.entries.map((entry) => entry.message));
  });
  runtimeLogs!.write({ source: "runtime", stream: "stdout", chunk: "after ready\n" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(publishedLogs.some((messages) => messages.includes("after ready")));
  assert.equal(service.snapshot().revision, started.snapshot.revision);
  unsubscribe();

  const stopped = await service.stop(1, started.snapshot.session!.id, started.snapshot.revision);
  assert.equal(stopped.snapshot.phase, "idle");
  assert.equal(stopped.snapshot.session, null);
  assert.equal(stopCalls, 1);
});

test("dependency preparation runs inside workspace staging and blocks publication/start on failure", async () => {
  let spawned = false;
  let published = false;
  const workspace: RuntimeWorkspace = {
    baselineIdentity: "baseline",
    baselinePath: "/tmp/baseline",
    runtimeId: "runtime",
    runtimePath: "/tmp/runtime",
    manifest: { formatVersion: 1, identity: "baseline", entries: [] },
  };
  const service = new RuntimeService(options({
    workspaces: { for: () => ({
      current: async () => undefined,
      stage: async (_source, stageOptions) => {
        await stageOptions?.prepareRuntime?.(workspace);
        published = true;
        return workspace;
      },
    }) },
    dependencies: {
      async createPreparation() {
        return { prepareRuntime: async () => { throw new Error("install failed"); } };
      },
      async restoreCurrent() {
        return { status: "missing" };
      },
    },
    supervisor: {
      managedLaunchSupported: true,
      spawn: async () => { spawned = true; throw new Error("not reached"); },
      stop: async () => undefined,
      recover: async () => [],
    },
  }));
  const initial = service.snapshot(1);
  const result = await service.start(1, "default", initial.revision);
  assert.equal(result.snapshot.problem?.code, "dependencies-failed");
  assert.equal(published, false);
  assert.equal(spawned, false);
});

test("managed start restores the durable current runtime without staging a replacement", async () => {
  const workspace: RuntimeWorkspace = {
    baselineIdentity: "baseline",
    baselinePath: "/tmp/baseline",
    runtimeId: "runtime",
    runtimePath: "/tmp/runtime",
    manifest: { formatVersion: 1, identity: "baseline", entries: [] },
  };
  let stageCalls = 0;
  let restoreCalls = 0;
  const service = new RuntimeService(options({
    workspaces: { for: () => ({
      current: async () => workspace,
      stage: async () => {
        stageCalls += 1;
        return workspace;
      },
    }) },
    dependencies: {
      async createPreparation() {
        throw new Error("staging preparation must not run");
      },
      async restoreCurrent(input) {
        restoreCalls += 1;
        assert.equal(input.workspace, workspace);
        return { status: "restored", result: { identity: "dependency" } };
      },
    },
    supervisor: {
      managedLaunchSupported: true,
      spawn: async () => { throw new Error("not reached"); },
      stop: async () => undefined,
      recover: async () => [],
    },
  }));

  const result = await service.start(1, "default", service.snapshot(1).revision);

  assert.equal(result.snapshot.problem?.code, "unsupported-runtime");
  assert.equal(stageCalls, 0);
  assert.equal(restoreCalls, 1);
});

test("a dependency restore miss preserves the edited current runtime instead of restaging source", async () => {
  const workspace: RuntimeWorkspace = {
    baselineIdentity: "baseline",
    baselinePath: "/tmp/baseline",
    runtimeId: "edited-runtime",
    runtimePath: "/tmp/edited-runtime",
    manifest: { formatVersion: 1, identity: "baseline", entries: [] },
  };
  let stageCalls = 0;
  let adoptCalls = 0;
  let spawned = false;
  const service = new RuntimeService(options({
    projects: {
      current: () => project(),
      adoptWorkspace: async () => { adoptCalls += 1; },
    },
    workspaces: { for: () => ({
      current: async () => workspace,
      stage: async () => {
        stageCalls += 1;
        throw new Error("must preserve the current runtime");
      },
    }) },
    dependencies: {
      async createPreparation() { throw new Error("must not prepare a replacement"); },
      async restoreCurrent() { return { status: "missing" }; },
    },
    supervisor: {
      managedLaunchSupported: true,
      spawn: async () => { spawned = true; throw new Error("must not start"); },
      stop: async () => undefined,
      recover: async () => [],
    },
  }));

  const result = await service.start(1, "default", service.snapshot(1).revision);

  assert.equal(result.snapshot.problem?.code, "dependencies-failed");
  assert.match(result.snapshot.problem?.message ?? "", /preserved the runtime and its edits/i);
  assert.equal(stageCalls, 0);
  assert.equal(adoptCalls, 0);
  assert.equal(spawned, false);
});
