import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectManifest } from "../../src/project-contracts.js";
import type { RuntimeWorkspace } from "../runtime-workspaces/types.js";
import { ApplicationStateStore } from "../storage/application-state-store.js";
import { ProjectTrustStore } from "./project-trust-store.js";
import { ProjectManager } from "./project-manager.js";
import { serializeProjectManifest } from "./project-manifest.js";
import { updateProjectManifest } from "./project-initializer.js";
import { detectProject } from "./project-detector.js";

function manifest(projectId: string, name: string): ProjectManifest {
  return {
    schemaVersion: 2,
    projectId,
    name,
    defaultRuntimeProfile: "dev",
    runtimeProfiles: {
      dev: {
        command: ["pnpm", "dev"],
        workingDirectory: ".",
        dependencyRoot: ".",
        host: "127.0.0.1",
        preferredPort: 3000,
        readiness: { path: "/", timeoutMs: 60_000 },
        entryRoute: "/",
        environment: { literals: {}, inherit: [], secrets: {} },
        runtimeAdapter: "vite",
        editorAdapter: "react-rewrite",
      },
    },
  };
}

async function fixture(parent: string, directory: string, projectId: string): Promise<string> {
  const root = path.join(parent, directory);
  await mkdir(path.join(root, ".larger"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10", scripts: { dev: "vite" }, devDependencies: { vite: "1" } }));
  await writeFile(path.join(root, ".larger", "project.json"), serializeProjectManifest(manifest(projectId, directory)));
  return root;
}

async function uninitializedFixture(parent: string, directory: string): Promise<string> {
  const root = path.join(parent, directory);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10", scripts: { dev: "vite" }, devDependencies: { vite: "1" } }));
  return root;
}

function managerFor(userData: string, options: Partial<ConstructorParameters<typeof ProjectManager>[0]> = {}) {
  return new ProjectManager({
    applicationState: new ApplicationStateStore(path.join(userData, "application.json")),
    trust: new ProjectTrustStore(path.join(userData, "trust.json")),
    createWorkspace: () => ({ stage: async () => { throw new Error("workspace not configured in this test"); } }),
    ...options,
  });
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

class DeferredTrustStore extends ProjectTrustStore {
  readonly gate = deferred();

  override async setDecision(...args: Parameters<ProjectTrustStore["setDecision"]>) {
    await this.gate.promise;
    return super.setDecision(...args);
  }
}

class DeferredApplicationStateStore extends ApplicationStateStore {
  readonly gate = deferred();

  override async setPersonalState(...args: Parameters<ApplicationStateStore["setPersonalState"]>) {
    await this.gate.promise;
    return super.setPersonalState(...args);
  }
}

class RevocationTrustStore extends ProjectTrustStore {
  readonly gate = deferred();
  block = false;

  override async setDecision(...args: Parameters<ProjectTrustStore["setDecision"]>) {
    if (this.block) await this.gate.promise;
    return super.setDecision(...args);
  }
}

test("opens, switches, persists personal state, and restores the last valid project", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-manager-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sourceRoot = path.join(temporary, "sources");
  const userData = path.join(temporary, "user-data");
  const firstPath = await fixture(sourceRoot, "first", "shared-project");
  const secondPath = await fixture(sourceRoot, "second", "second-project");
  const clonePath = await fixture(sourceRoot, "clone", "shared-project");
  const manager = managerFor(userData);

  await manager.bootstrap();
  assert.equal(manager.snapshot().active, null);
  await manager.openPath(firstPath);
  const first = manager.snapshot().active!;
  await manager.setTrust(first.generation, "trusted");
  await manager.updatePersonalState(first.generation, { selectedRuntimeProfile: "dev", lastRoute: "/about" });
  await manager.openPath(secondPath);
  assert.equal(manager.snapshot().active?.manifest.name, "second");

  const restored = managerFor(userData);
  await restored.bootstrap();
  assert.equal(restored.snapshot().active?.manifest.name, "second");

  await restored.openPath(clonePath);
  const clone = restored.snapshot().active!;
  assert.notEqual(clone.identity.instanceKey, first.identity.instanceKey);
  assert.equal(clone.trust, "undecided");
});

test("a stale slow open cannot overwrite a newer committed project", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-manager-race-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sourceRoot = path.join(temporary, "sources");
  const slowPath = await fixture(sourceRoot, "slow", "slow-project");
  const fastPath = await fixture(sourceRoot, "fast", "fast-project");
  let releaseSlow: (() => void) | undefined;
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const manager = managerFor(path.join(temporary, "state"), {
    detect: async (projectPath, options) => {
      if (path.resolve(projectPath) === path.resolve(slowPath)) await slowGate;
      options?.signal?.throwIfAborted();
      return detectProject(projectPath, options);
    },
  });
  await manager.bootstrap();
  const slow = manager.openPath(slowPath);
  const fast = manager.openPath(fastPath);
  await fast;
  releaseSlow?.();
  const slowResult = await slow;
  assert.equal(slowResult.status, "cancelled");
  assert.equal(manager.snapshot().active?.manifest.name, "fast");
  assert.equal(manager.snapshot().recentProjects.some((recent) => recent.displayName === "slow"), false);
});

test("pending repositories suspend one active project and dismiss restores a fresh usable generation", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-manager-pending-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sources = path.join(temporary, "sources");
  const activePath = await fixture(sources, "active", "active-project");
  const uninitializedPath = await uninitializedFixture(sources, "new-project");
  const invalidPath = await uninitializedFixture(sources, "invalid-project");
  await mkdir(path.join(invalidPath, ".larger"));
  await writeFile(path.join(invalidPath, ".larger", "project.json"), "{ invalid json\n");
  const manager = managerFor(path.join(temporary, "state"));
  await manager.bootstrap();
  await manager.openPath(activePath);
  const originalGeneration = manager.snapshot().active!.generation;

  await manager.openPath(uninitializedPath);
  let snapshot = manager.snapshot();
  assert.equal(snapshot.active, null);
  assert.equal(snapshot.pending?.reason, "needs-initialization");
  await manager.dismissPending(snapshot.pending!.generation);
  snapshot = manager.snapshot();
  assert.equal(snapshot.pending, null);
  assert.equal(snapshot.active?.manifest.name, "active");
  assert.ok(snapshot.active!.generation > originalGeneration);
  await manager.setTrust(snapshot.active!.generation, "trusted");
  await manager.updatePersonalState(snapshot.active!.generation, { selectedSection: "assets" });
  assert.equal(manager.snapshot().active?.personalState.selectedSection, "assets");

  await manager.openPath(invalidPath);
  snapshot = manager.snapshot();
  assert.equal(snapshot.active, null);
  assert.equal(snapshot.pending?.reason, "invalid-manifest");
  await manager.dismissPending(snapshot.pending!.generation);
  assert.equal(manager.snapshot().active?.manifest.name, "active");
});

test("initialization commits the confirmed manifest and activates the new project", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-manager-initialize-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = await uninitializedFixture(path.join(temporary, "sources"), "new-project");
  const manager = managerFor(path.join(temporary, "state"));
  await manager.bootstrap();
  await manager.openPath(source);
  const pending = manager.snapshot().pending!;
  assert.equal(pending.reason, "needs-initialization");
  assert.ok(pending.suggestedManifest);
  const snapshots = [manager.snapshot()];
  const unsubscribe = manager.subscribe((snapshot) => snapshots.push(snapshot));
  const result = await manager.initialize(pending.generation, {
    ...pending.suggestedManifest!,
    name: "Confirmed project",
    runtimeProfiles: {
      dev: {
        ...pending.suggestedManifest!.runtimeProfiles.dev!,
        command: ["pnpm", "--filter", "app with spaces", "dev"],
      },
    },
  });
  unsubscribe();
  assert.equal(result.status, "completed");
  assert.ok(snapshots.every((snapshot) => snapshot.active !== null || snapshot.pending !== null));
  assert.equal(manager.snapshot().pending, null);
  assert.equal(manager.snapshot().active?.manifest.name, "Confirmed project");
  assert.deepEqual(manager.snapshot().active?.manifest.runtimeProfiles.dev?.command, [
    "pnpm", "--filter", "app with spaces", "dev",
  ]);
});

test("failed initialization never clears the pending project during its transition", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-manager-initialize-failure-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = await uninitializedFixture(path.join(temporary, "sources"), "new-project");
  const manager = managerFor(path.join(temporary, "state"));
  await manager.bootstrap();
  await manager.openPath(source);
  const pending = manager.snapshot().pending!;
  const snapshots = [manager.snapshot()];
  const unsubscribe = manager.subscribe((snapshot) => snapshots.push(snapshot));

  const result = await manager.initialize(pending.generation, {
    ...pending.suggestedManifest!,
    runtimeProfiles: {
      dev: {
        ...pending.suggestedManifest!.runtimeProfiles.dev!,
        entryRoute: "missing-leading-slash",
      },
    },
  });
  unsubscribe();

  assert.equal(result.status, "completed");
  assert.equal(manager.snapshot().pending?.reason, "needs-initialization");
  assert.equal(manager.snapshot().problem?.code, "invalid-manifest");
  assert.ok(snapshots.every((snapshot) => snapshot.active !== null || snapshot.pending !== null));
});

test("a failed session stop blocks switching and preserves the active project", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-manager-guard-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sourceRoot = path.join(temporary, "sources");
  const firstPath = await fixture(sourceRoot, "first", "first-project");
  const secondPath = await fixture(sourceRoot, "second", "second-project");
  let activeSession = false;
  const manager = managerFor(path.join(temporary, "state"), {
    switchGuard: {
      hasActiveSession: () => activeSession,
      stopForProjectSwitch: async () => { throw new Error("Session refused to stop"); },
    },
  });
  await manager.bootstrap();
  await manager.openPath(firstPath);
  activeSession = true;
  await manager.openPath(secondPath);
  assert.equal(manager.snapshot().active?.manifest.name, "first");
  assert.match(manager.snapshot().problem?.message ?? "", /refused to stop/);
});

test("revoking trust durably denies the project and stops active project activity", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-manager-trust-revoke-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = await fixture(path.join(temporary, "sources"), "project", "trust-project");
  let activeSession = false;
  let stopCalls = 0;
  const manager = managerFor(path.join(temporary, "state"), {
    switchGuard: {
      hasActiveSession: () => activeSession,
      stopForProjectSwitch: async () => {
        stopCalls += 1;
        activeSession = false;
      },
    },
  });
  await manager.bootstrap();
  await manager.openPath(source);
  const opened = manager.snapshot().active!;
  await manager.setTrust(opened.generation, "trusted");
  activeSession = true;

  const denied = await manager.setTrust(opened.generation, "denied");

  assert.equal(denied.snapshot.active?.trust, "denied");
  assert.equal(activeSession, false);
  assert.equal(stopCalls, 1);
});

test("a cleanup failure cannot roll back a durable trust revocation after restart", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-manager-trust-cleanup-failure-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const statePath = path.join(temporary, "state");
  const source = await fixture(path.join(temporary, "sources"), "project", "trust-cleanup-failure-project");
  let activeSession = false;
  const manager = managerFor(statePath, {
    switchGuard: {
      hasActiveSession: () => activeSession,
      stopForProjectSwitch: async () => { throw new Error("Session refused to stop"); },
    },
  });
  await manager.bootstrap();
  await manager.openPath(source);
  const opened = manager.snapshot().active!;
  await manager.setTrust(opened.generation, "trusted");
  activeSession = true;

  await assert.rejects(manager.setTrust(opened.generation, "denied"), /Session refused to stop/);
  assert.equal(manager.snapshot().active?.trust, "denied");

  const reopened = managerFor(statePath);
  await reopened.bootstrap();
  await reopened.openPath(source);
  assert.equal(reopened.snapshot().active?.trust, "denied");
});

test("revoking trust publishes an in-memory denial before asynchronous persistence", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-manager-trust-race-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const statePath = path.join(temporary, "state");
  const source = await fixture(path.join(temporary, "sources"), "project", "trust-race-project");
  const trust = new RevocationTrustStore(path.join(statePath, "trust.json"));
  const manager = managerFor(statePath, { trust });
  await manager.bootstrap();
  await manager.openPath(source);
  const opened = manager.snapshot().active!;
  await manager.setTrust(opened.generation, "trusted");
  trust.block = true;

  const revocation = manager.setTrust(opened.generation, "denied");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(manager.snapshot().active?.trust, "denied");
  trust.gate.release();
  assert.equal((await revocation).snapshot.active?.trust, "denied");
});

test("late trust and personal-state writes cannot reinsert a switched-away project", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-manager-late-write-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const firstPath = await fixture(path.join(temporary, "sources"), "first", "first-project");
  const secondPath = await fixture(path.join(temporary, "sources"), "second", "second-project");
  const statePath = path.join(temporary, "state");
  const trust = new DeferredTrustStore(path.join(statePath, "trust.json"));
  const applicationState = new DeferredApplicationStateStore(path.join(statePath, "application.json"));
  const manager = managerFor(statePath, { trust, applicationState });
  await manager.bootstrap();
  await manager.openPath(firstPath);
  const first = manager.snapshot().active!;

  const lateTrust = manager.setTrust(first.generation, "trusted");
  const latePersonalState = manager.updatePersonalState(first.generation, { lastRoute: "/late" });
  await manager.openPath(secondPath);
  trust.gate.release();
  applicationState.gate.release();
  assert.equal((await lateTrust).status, "cancelled");
  assert.equal((await latePersonalState).status, "cancelled");
  assert.equal(manager.snapshot().active?.manifest.name, "second");
});

test("workspace preparation is trust-gated and publishes only public baseline metadata", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-manager-workspace-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = await fixture(path.join(temporary, "sources"), "project", "workspace-project");
  const staged: RuntimeWorkspace = {
    baselineIdentity: "a".repeat(64),
    baselinePath: "/private/baseline",
    runtimeId: "00000000-0000-4000-8000-000000000000",
    runtimePath: "/private/runtime",
    manifest: { formatVersion: 1, identity: "a".repeat(64), entries: [] },
  };
  let workspaceFactories = 0;
  let stageCalls = 0;
  let activeSession = false;
  let stopCalls = 0;
  let refuseStop = false;
  const manager = managerFor(path.join(temporary, "state"), {
    createWorkspace: () => {
      workspaceFactories += 1;
      return { stage: async () => {
        stageCalls += 1;
        assert.equal(activeSession, false);
        return staged;
      } };
    },
    switchGuard: {
      hasActiveSession: () => activeSession,
      stopForProjectSwitch: async () => {
        stopCalls += 1;
        if (refuseStop) throw new Error("Source apply is still active");
        activeSession = false;
      },
    },
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
  await manager.bootstrap();
  await manager.openPath(source);
  const initial = manager.snapshot().active!;
  await manager.prepareWorkspace(initial.generation);
  assert.equal(manager.snapshot().active?.workspace, null);
  assert.equal(manager.snapshot().problem?.code, "not-trusted");
  await manager.setTrust(initial.generation, "trusted");
  activeSession = true;
  refuseStop = true;
  await manager.prepareWorkspace(initial.generation);
  assert.equal(manager.snapshot().problem?.code, "switch-blocked");
  assert.equal(manager.snapshot().active?.workspace, null);
  assert.equal(stageCalls, 0);
  refuseStop = false;
  await manager.prepareWorkspace(initial.generation);
  assert.deepEqual(manager.snapshot().active?.workspace, {
    baselineIdentity: staged.baselineIdentity,
    runtimeId: staged.runtimeId,
    preparedAt: "2026-08-10T12:00:00.000Z",
  });
  assert.equal(JSON.stringify(manager.snapshot()).includes("/private/runtime"), false);
  assert.equal(stopCalls, 2);
  assert.equal(stageCalls, 1);
  const prepared = manager.snapshot().active!;
  await manager.prepareWorkspace(prepared.generation);
  assert.equal(workspaceFactories, 1);
});

test("adopts only the registry's current workspace for the active trusted project", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-manager-adopt-workspace-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = await fixture(path.join(temporary, "sources"), "project", "adopt-workspace-project");
  const published: RuntimeWorkspace = {
    baselineIdentity: "b".repeat(64),
    baselinePath: "/private/baseline",
    runtimeId: "00000000-0000-4000-8000-000000000001",
    runtimePath: "/private/runtime",
    manifest: { formatVersion: 1, identity: "b".repeat(64), entries: [] },
  };
  const manager = managerFor(path.join(temporary, "state"), {
    createWorkspace: () => ({
      stage: async () => published,
      current: async () => published,
    }),
    now: () => new Date("2026-08-11T12:00:00.000Z"),
  });
  await manager.bootstrap();
  await manager.openPath(source);
  const opened = manager.snapshot().active!;
  await manager.setTrust(opened.generation, "trusted");
  const active = manager.snapshot().active!;
  await manager.adoptPublishedWorkspace(active.generation, active.identity.instanceKey, published);
  assert.deepEqual(manager.snapshot().active?.workspace, {
    baselineIdentity: published.baselineIdentity,
    runtimeId: published.runtimeId,
    preparedAt: "2026-08-11T12:00:00.000Z",
  });
  await assert.rejects(
    manager.adoptPublishedWorkspace(active.generation, "other-instance", published),
    /not authorized/,
  );
  await assert.rejects(
    manager.adoptPublishedWorkspace(active.generation, active.identity.instanceKey, {
      ...published,
      runtimeId: "00000000-0000-4000-8000-000000000002",
    }),
    /publication is stale/,
  );
});

test("project settings preserve stable identity and reopen through the safe manifest path", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-manager-settings-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = await fixture(path.join(temporary, "sources"), "project", "settings-project");
  const manager = managerFor(path.join(temporary, "state"));
  await manager.bootstrap();
  await manager.openPath(source);
  const active = manager.snapshot().active!;
  await manager.updateManifest(active.generation, { ...active.manifest, name: "Renamed" });
  assert.equal(manager.snapshot().active?.manifest.name, "Renamed");
  const current = manager.snapshot().active!;
  await assert.rejects(
    manager.updateManifest(current.generation, { ...current.manifest, projectId: "different-project" }),
    /stable project ID/,
  );
});

test("a superseded manifest update cannot publish into the previous repository", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-manager-update-race-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sources = path.join(temporary, "sources");
  const firstPath = await fixture(sources, "first", "first-project");
  const secondPath = await fixture(sources, "second", "second-project");
  const gate = deferred();
  const manager = managerFor(path.join(temporary, "state"), {
    updateManifest: async (...args) => {
      await gate.promise;
      return updateProjectManifest(...args);
    },
  });
  await manager.bootstrap();
  await manager.openPath(firstPath);
  const first = manager.snapshot().active!;
  const update = manager.updateManifest(first.generation, { ...first.manifest, name: "Should not publish" });
  await manager.openPath(secondPath);
  gate.release();
  assert.equal((await update).status, "cancelled");
  const stored = JSON.parse(await readFile(path.join(firstPath, ".larger", "project.json"), "utf8")) as ProjectManifest;
  assert.equal(stored.name, "first");
  assert.equal(manager.snapshot().active?.manifest.name, "second");
});
