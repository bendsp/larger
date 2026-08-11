import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ChangeSelection, TextFileChange } from "../../src/change-contracts.js";
import type { ActiveProject } from "../../src/project-ipc.js";
import { ProjectActivityCoordinator } from "../projects/project-activity.js";
import { RuntimeWorkspaceProvider } from "../runtime-workspaces/provider.js";
import type { RuntimeWorkspace } from "../runtime-workspaces/types.js";
import { ChangeService, type ChangeServiceDependencies } from "./change-service.js";

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly provider: RuntimeWorkspaceProvider;
  readonly activity: ProjectActivityCoordinator;
  readonly active: ActiveProject;
  readonly dependencies: ChangeServiceDependencies;
  readonly service: ChangeService;
  workspace: RuntimeWorkspace;
}

function selectionFor(files: readonly TextFileChange[]): ChangeSelection {
  return {
    files: files.map((file) => ({
      fileId: file.id,
      includeFile: true,
      hunkIds: file.hunks.map((hunk) => hunk.id),
    })),
  };
}

async function createFixture(
  context: test.TestContext,
  files: Readonly<Record<string, string>>,
  options: Pick<ChangeServiceDependencies, "onTransactionPhase"> = {},
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-change-service-"));
  context.after(async () => {
    await makeTestTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, "source");
  const userDataPath = path.join(root, "user-data");
  await mkdir(sourceRoot, { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(sourceRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const instanceKey = "change-service-test";
  const provider = new RuntimeWorkspaceProvider({ userDataPath, localInstanceKey: instanceKey });
  let workspace = await provider.stage(sourceRoot);
  const active: ActiveProject = {
    generation: 7,
    manifest: {
      schemaVersion: 2,
      projectId: "project-change-service",
      name: "Change service test",
      defaultRuntimeProfile: "web",
      runtimeProfiles: {
        web: {
          command: ["pnpm", "dev"],
          workingDirectory: ".",
          dependencyRoot: ".",
          host: "127.0.0.1",
          preferredPort: 4310,
          readiness: { path: "/", timeoutMs: 60_000 },
          entryRoute: "/",
          environment: { literals: {}, inherit: [], secrets: {} },
          runtimeAdapter: "vite",
          editorAdapter: "react-rewrite",
        },
      },
    },
    identity: { projectId: "project-change-service", instanceKey, canonicalPath: sourceRoot },
    detection: {} as ActiveProject["detection"],
    trust: "trusted",
    personalState: {},
    workspace: {
      baselineIdentity: workspace.baselineIdentity,
      runtimeId: workspace.runtimeId,
      preparedAt: new Date().toISOString(),
    },
  };
  const workspaceGateway = {
    current: async () => provider.current(),
    for: () => ({
      current: async () => provider.current(),
      resetCurrent: async () => {
        workspace = await provider.resetCurrent();
        return workspace;
      },
    }),
  };
  const activity = new ProjectActivityCoordinator();
  const dependencies: ChangeServiceDependencies = {
    userDataPath,
    projects: {
      activeForChanges: (generation) => {
        if (generation !== active.generation) throw new Error("stale generation");
        return structuredClone(active);
      },
      authorizeSourceOperation: async (generation, expectedInstanceKey) => {
        if (generation !== active.generation || expectedInstanceKey !== active.identity.instanceKey) {
          throw new Error("stale source authorization");
        }
        return structuredClone(active);
      },
    },
    workspaces: workspaceGateway,
    activity,
    ...options,
  };
  const fixture: Fixture = {
    root,
    sourceRoot,
    provider,
    activity,
    active,
    dependencies,
    service: new ChangeService(dependencies),
    workspace,
  };
  return fixture;
}

async function makeTestTreeWritable(root: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(root);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    await chmod(root, 0o600);
    return;
  }
  await chmod(root, 0o700);
  for (const child of await readdir(root)) await makeTestTreeWritable(path.join(root, child));
}

async function scanAndSelectAll(fixture: Fixture): Promise<{
  readonly changeSetId: string;
  readonly revision: number;
  readonly files: readonly TextFileChange[];
}> {
  const scan = await fixture.service.scan(fixture.active.generation);
  const changeSet = scan.snapshot.changeSet;
  assert.ok(changeSet);
  const files = changeSet.files.filter((file): file is TextFileChange => file.kind === "text");
  assert.ok(files.length > 0);
  const selected = await fixture.service.updateSelection(
    fixture.active.generation,
    changeSet.id,
    changeSet.revision,
    selectionFor(files),
  );
  assert.ok(selected.snapshot.changeSet);
  return {
    changeSetId: selected.snapshot.changeSet.id,
    revision: selected.snapshot.changeSet.revision,
    files,
  };
}

async function runCrashChild(
  fixture: Fixture,
  operation: "prepare" | "commit" | "recover",
  phase: string,
  transaction?: { transactionId: string; planDigest: string },
): Promise<void> {
  const markerPath = path.join(fixture.root, `crash-${phase}.marker`);
  const configPath = path.join(fixture.root, `crash-${phase}.json`);
  await writeFile(configPath, `${JSON.stringify({
    userDataPath: path.join(fixture.root, "user-data"),
    sourceRoot: fixture.sourceRoot,
    instanceKey: fixture.active.identity.instanceKey,
    active: fixture.active,
    markerPath,
    ...transaction,
  })}\n`, { mode: 0o600 });
  const childPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "change-service-crash-child.ts");
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", childPath, configPath, operation, phase], {
      cwd: path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
  assert.equal(result.signal, "SIGKILL", result.stderr || `Child exited with code ${result.code}.`);
  assert.equal(await readFile(markerPath, "utf8"), `${phase}\n`);
}

test("prepares from durable blobs and applies one selected hunk while preserving non-overlapping source drift", async (context) => {
  const baseline = Array.from({ length: 16 }, (_, index) => `line-${index + 1}`).join("\n") + "\n";
  const fixture = await createFixture(context, { "src/app.txt": baseline });
  const runtimeLines = baseline.split("\n");
  runtimeLines[0] = "runtime-first";
  runtimeLines[12] = "runtime-thirteenth";
  await writeFile(path.join(fixture.workspace.runtimePath, "src/app.txt"), runtimeLines.join("\n"));

  const scan = await fixture.service.scan(fixture.active.generation);
  const changeSet = scan.snapshot.changeSet;
  assert.ok(changeSet);
  const file = changeSet.files.find((candidate): candidate is TextFileChange => candidate.kind === "text");
  assert.ok(file);
  assert.equal(file.hunks.length, 2);
  const firstHunk = file.hunks[0];
  assert.ok(firstHunk);
  const selected = await fixture.service.updateSelection(
    fixture.active.generation,
    changeSet.id,
    changeSet.revision,
    { files: [{ fileId: file.id, includeFile: true, hunkIds: [firstHunk.id] }] },
  );
  const selectedSet = selected.snapshot.changeSet;
  assert.ok(selectedSet);

  const sourceLines = baseline.split("\n");
  sourceLines[6] = "source-seventh";
  await writeFile(path.join(fixture.sourceRoot, "src/app.txt"), sourceLines.join("\n"));
  const prepared = await fixture.service.prepareApply(
    fixture.active.generation,
    selectedSet.id,
    selectedSet.revision,
  );
  assert.equal(prepared.status, "prepared");
  assert.ok(prepared.transactionId);
  assert.ok(prepared.planDigest);
  assert.equal((await readFile(path.join(fixture.sourceRoot, "src/app.txt"), "utf8")).includes("runtime-first"), false);

  const committed = await fixture.service.commitApply(
    fixture.active.generation,
    prepared.transactionId,
    prepared.planDigest,
  );
  assert.equal(committed.snapshot.changeSet?.status, "applied");
  const result = await readFile(path.join(fixture.sourceRoot, "src/app.txt"), "utf8");
  assert.match(result, /^runtime-first\n/);
  assert.match(result, /source-seventh/);
  assert.match(result, /line-13/);
  assert.doesNotMatch(result, /runtime-thirteenth/);
});

test("applies in a dirty Git-shaped project without touching unrelated source bytes", async (context) => {
  const fixture = await createFixture(context, {
    "src/app.txt": "before\n",
    "src/unrelated.txt": "clean\n",
  });
  await mkdir(path.join(fixture.sourceRoot, ".git"));
  await writeFile(path.join(fixture.sourceRoot, ".git/HEAD"), "ref: refs/heads/mvp\n");
  await writeFile(path.join(fixture.workspace.runtimePath, "src/app.txt"), "after\n");
  const selected = await scanAndSelectAll(fixture);
  const unrelatedBytes = Buffer.from("dirty unrelated\r\n", "utf8");
  await writeFile(path.join(fixture.sourceRoot, "src/unrelated.txt"), unrelatedBytes);
  const prepared = await fixture.service.prepareApply(
    fixture.active.generation,
    selected.changeSetId,
    selected.revision,
  );
  assert.equal(prepared.status, "prepared");
  assert.ok(prepared.transactionId && prepared.planDigest);
  const committed = await fixture.service.commitApply(
    fixture.active.generation,
    prepared.transactionId,
    prepared.planDigest,
  );
  assert.equal(committed.snapshot.changeSet?.status, "applied");
  assert.equal(await readFile(path.join(fixture.sourceRoot, "src/app.txt"), "utf8"), "after\n");
  assert.deepEqual(await readFile(path.join(fixture.sourceRoot, "src/unrelated.txt")), unrelatedBytes);
  assert.equal(await readFile(path.join(fixture.sourceRoot, ".git/HEAD"), "utf8"), "ref: refs/heads/mvp\n");
});

test("reports overlapping drift before creating a source-writing transaction", async (context) => {
  const fixture = await createFixture(context, { "src/app.txt": "before\nsecond\n" });
  await writeFile(path.join(fixture.workspace.runtimePath, "src/app.txt"), "runtime\nsecond\n");
  const selected = await scanAndSelectAll(fixture);
  await writeFile(path.join(fixture.sourceRoot, "src/app.txt"), "source\nsecond\n");

  const prepared = await fixture.service.prepareApply(
    fixture.active.generation,
    selected.changeSetId,
    selected.revision,
  );
  assert.equal(prepared.status, "conflicted");
  assert.equal(prepared.transactionId, null);
  assert.deepEqual(prepared.conflictPaths, ["src/app.txt"]);
  assert.equal(await readFile(path.join(fixture.sourceRoot, "src/app.txt"), "utf8"), "source\nsecond\n");
});

test("recovers by rolling forward after termination immediately after a durable source replacement", async (context) => {
  let crashOnce = true;
  const fixture = await createFixture(context, { "src/app.txt": "before\n" }, {
    onTransactionPhase: (phase) => {
      if (phase === "file-source-durable" && crashOnce) {
        crashOnce = false;
        throw new Error("simulated termination after durable source write");
      }
    },
  });
  await writeFile(path.join(fixture.workspace.runtimePath, "src/app.txt"), "after\n");
  const selected = await scanAndSelectAll(fixture);
  const prepared = await fixture.service.prepareApply(
    fixture.active.generation,
    selected.changeSetId,
    selected.revision,
  );
  assert.equal(prepared.status, "prepared");
  assert.ok(prepared.transactionId && prepared.planDigest);

  const interrupted = await fixture.service.commitApply(
    fixture.active.generation,
    prepared.transactionId,
    prepared.planDigest,
  );
  assert.equal(await readFile(path.join(fixture.sourceRoot, "src/app.txt"), "utf8"), "after\n");
  assert.equal(interrupted.snapshot.changeSet?.recovery?.actionRequired, true);
  assert.equal(interrupted.snapshot.changeSet?.recovery?.appliedCount, 1);
  assert.equal(interrupted.snapshot.changeSet?.recovery?.pendingCount, 0);

  const restarted = new ChangeService({ ...fixture.dependencies, onTransactionPhase: undefined });
  const restored = await restarted.snapshot(fixture.active.generation);
  assert.equal(restored.changeSet?.application?.transactionId, prepared.transactionId);
  assert.equal(restored.changeSet?.recovery?.actionRequired, true);
  assert.equal(restored.changeSet?.recovery?.appliedCount, 1);
  assert.equal(restored.changeSet?.application?.files[0]?.outcome, "applied");
  await assert.rejects(
    restarted.scan(fixture.active.generation),
    /Recover the active source transaction/,
  );
  const recovered = await restarted.recover(fixture.active.generation, prepared.transactionId, "roll-forward");
  assert.equal(recovered.snapshot.changeSet?.status, "applied");
  assert.equal(recovered.snapshot.changeSet?.recovery?.actionRequired, false);
  assert.equal(await readFile(path.join(fixture.sourceRoot, "src/app.txt"), "utf8"), "after\n");
});

test("rolls a conflicted partial transaction forward after source returns to its expected state", async (context) => {
  let interfereOnce = true;
  let sourceRoot = "";
  const fixture = await createFixture(context, {
    "src/a.txt": "before a\n",
    "src/b.txt": "before b\n",
  }, {
    onTransactionPhase: async (phase) => {
      if (phase === "file-source-durable" && interfereOnce) {
        interfereOnce = false;
        await writeFile(path.join(sourceRoot, "src/b.txt"), "interference\n");
      }
    },
  });
  sourceRoot = fixture.sourceRoot;
  await writeFile(path.join(fixture.workspace.runtimePath, "src/a.txt"), "after a\n");
  await writeFile(path.join(fixture.workspace.runtimePath, "src/b.txt"), "after b\n");
  const selected = await scanAndSelectAll(fixture);
  const prepared = await fixture.service.prepareApply(
    fixture.active.generation,
    selected.changeSetId,
    selected.revision,
  );
  assert.equal(prepared.status, "prepared");
  assert.ok(prepared.transactionId && prepared.planDigest);

  const interrupted = await fixture.service.commitApply(
    fixture.active.generation,
    prepared.transactionId,
    prepared.planDigest,
  );
  assert.equal(interrupted.snapshot.changeSet?.status, "conflicted");
  assert.equal(await readFile(path.join(sourceRoot, "src/a.txt"), "utf8"), "after a\n");
  assert.equal(await readFile(path.join(sourceRoot, "src/b.txt"), "utf8"), "interference\n");

  await writeFile(path.join(sourceRoot, "src/b.txt"), "before b\n");
  const restarted = new ChangeService({ ...fixture.dependencies, onTransactionPhase: undefined });
  const restored = await restarted.snapshot(fixture.active.generation);
  assert.equal(restored.changeSet?.status, "conflicted");
  assert.ok(restored.changeSet?.recovery?.availableActions.includes("roll-forward"));
  const recovered = await restarted.recover(
    fixture.active.generation,
    prepared.transactionId,
    "roll-forward",
  );
  assert.equal(recovered.snapshot.changeSet?.status, "applied");
  assert.equal(recovered.snapshot.changeSet?.recovery?.actionRequired, false);
  assert.equal(await readFile(path.join(sourceRoot, "src/a.txt"), "utf8"), "after a\n");
  assert.equal(await readFile(path.join(sourceRoot, "src/b.txt"), "utf8"), "after b\n");
});

test("confirmed discard replaces the edited runtime and a subsequent scan stays clean", async (context) => {
  const fixture = await createFixture(context, { "src/app.txt": "baseline\n" });
  await writeFile(path.join(fixture.workspace.runtimePath, "src/app.txt"), "runtime edit\n");
  const scan = await fixture.service.scan(fixture.active.generation);
  const changeSet = scan.snapshot.changeSet;
  assert.ok(changeSet);
  assert.equal(changeSet.files.length, 1);

  const discarded = await fixture.service.discard(
    fixture.active.generation,
    changeSet.id,
    changeSet.revision,
    true,
  );
  assert.equal(discarded.snapshot.changeSet?.status, "discarded");
  fixture.workspace = (await fixture.provider.current())!;
  assert.equal(await readFile(path.join(fixture.workspace.runtimePath, "src/app.txt"), "utf8"), "baseline\n");
  const clean = await fixture.service.scan(fixture.active.generation);
  assert.deepEqual(clean.snapshot.changeSet?.files, []);
});

test("retries prepare idempotently after a lost reply", async (context) => {
  const fixture = await createFixture(context, { "src/app.txt": "before\n" });
  await writeFile(path.join(fixture.workspace.runtimePath, "src/app.txt"), "after\n");
  const selected = await scanAndSelectAll(fixture);
  const first = await fixture.service.prepareApply(
    fixture.active.generation,
    selected.changeSetId,
    selected.revision,
  );
  const restarted = new ChangeService(fixture.dependencies);
  const retry = await restarted.prepareApply(
    fixture.active.generation,
    selected.changeSetId,
    selected.revision,
  );
  assert.equal(first.status, "prepared");
  assert.equal(retry.status, "prepared");
  assert.equal(retry.transactionId, first.transactionId);
  assert.equal(retry.planDigest, first.planDigest);
  assert.equal(retry.snapshot.changeSet?.revision, first.snapshot.changeSet?.revision);
  assert.equal(await readFile(path.join(fixture.sourceRoot, "src/app.txt"), "utf8"), "before\n");
});

test("prepare and commit do not read the disposable runtime after scanning", async (context) => {
  const fixture = await createFixture(context, { "src/app.txt": "before\n" });
  await writeFile(path.join(fixture.workspace.runtimePath, "src/app.txt"), "after\n");
  const selected = await scanAndSelectAll(fixture);
  await rm(fixture.workspace.runtimePath, { recursive: true, force: true });

  const prepared = await fixture.service.prepareApply(
    fixture.active.generation,
    selected.changeSetId,
    selected.revision,
  );
  assert.equal(prepared.status, "prepared");
  assert.ok(prepared.transactionId && prepared.planDigest);
  const committed = await fixture.service.commitApply(
    fixture.active.generation,
    prepared.transactionId,
    prepared.planDigest,
  );
  assert.equal(committed.snapshot.changeSet?.status, "applied");
  assert.equal(await readFile(path.join(fixture.sourceRoot, "src/app.txt"), "utf8"), "after\n");
});

test("rolls back an honest partial multi-file transaction from durable backups", async (context) => {
  let crashOnce = true;
  const fixture = await createFixture(context, {
    "src/a.txt": "a-before\n",
    "src/b.txt": "b-before\n",
  }, {
    onTransactionPhase: (phase) => {
      if (phase === "file-source-durable" && crashOnce) {
        crashOnce = false;
        throw new Error("simulated termination in a multi-file transaction");
      }
    },
  });
  await writeFile(path.join(fixture.workspace.runtimePath, "src/a.txt"), "a-after\n");
  await writeFile(path.join(fixture.workspace.runtimePath, "src/b.txt"), "b-after\n");
  const selected = await scanAndSelectAll(fixture);
  const prepared = await fixture.service.prepareApply(
    fixture.active.generation,
    selected.changeSetId,
    selected.revision,
  );
  assert.equal(prepared.status, "prepared");
  assert.ok(prepared.transactionId && prepared.planDigest);
  const interrupted = await fixture.service.commitApply(
    fixture.active.generation,
    prepared.transactionId,
    prepared.planDigest,
  );
  assert.equal(interrupted.snapshot.changeSet?.recovery?.actionRequired, true);
  assert.equal(await readFile(path.join(fixture.sourceRoot, "src/a.txt"), "utf8"), "a-after\n");
  assert.equal(await readFile(path.join(fixture.sourceRoot, "src/b.txt"), "utf8"), "b-before\n");

  const restarted = new ChangeService({ ...fixture.dependencies, onTransactionPhase: undefined });
  const recovered = await restarted.recover(fixture.active.generation, prepared.transactionId, "roll-back");
  assert.equal(recovered.snapshot.changeSet?.status, "reviewing");
  assert.equal(recovered.snapshot.changeSet?.recovery?.actionRequired, false);
  assert.equal(await readFile(path.join(fixture.sourceRoot, "src/a.txt"), "utf8"), "a-before\n");
  assert.equal(await readFile(path.join(fixture.sourceRoot, "src/b.txt"), "utf8"), "b-before\n");
});

test("cancels a prepared plan without changing source and returns to review", async (context) => {
  const fixture = await createFixture(context, { "src/app.txt": "before\n" });
  await writeFile(path.join(fixture.workspace.runtimePath, "src/app.txt"), "after\n");
  const selected = await scanAndSelectAll(fixture);
  const prepared = await fixture.service.prepareApply(
    fixture.active.generation,
    selected.changeSetId,
    selected.revision,
  );
  assert.equal(prepared.status, "prepared");
  assert.ok(prepared.transactionId);

  const cancelled = await fixture.service.recover(
    fixture.active.generation,
    prepared.transactionId,
    "roll-back",
  );
  assert.equal(cancelled.snapshot.changeSet?.status, "reviewing");
  assert.equal(cancelled.snapshot.changeSet?.recovery?.actionRequired, false);
  assert.equal(await readFile(path.join(fixture.sourceRoot, "src/app.txt"), "utf8"), "before\n");
});

test("recovers planned parent directories when application stops after mkdir durability", async (context) => {
  let stopOnce = true;
  const fixture = await createFixture(context, {}, {
    onTransactionPhase: (phase) => {
      if (phase === "directories-recorded" && stopOnce) {
        stopOnce = false;
        throw new Error("simulated termination after durable parent creation");
      }
    },
  });
  const runtimeFile = path.join(fixture.workspace.runtimePath, "src/generated/app.txt");
  await mkdir(path.dirname(runtimeFile), { recursive: true });
  await writeFile(runtimeFile, "generated\n");
  const selected = await scanAndSelectAll(fixture);
  const prepared = await fixture.service.prepareApply(
    fixture.active.generation,
    selected.changeSetId,
    selected.revision,
  );
  assert.equal(prepared.status, "prepared");
  assert.ok(prepared.transactionId && prepared.planDigest);

  const interrupted = await fixture.service.commitApply(
    fixture.active.generation,
    prepared.transactionId,
    prepared.planDigest,
  );
  assert.equal(interrupted.snapshot.changeSet?.recovery?.actionRequired, true);
  await assert.rejects(lstat(path.join(fixture.sourceRoot, "src/generated/app.txt")), /ENOENT/);
  assert.equal((await lstat(path.join(fixture.sourceRoot, "src/generated"))).isDirectory(), true);

  const restarted = new ChangeService({ ...fixture.dependencies, onTransactionPhase: undefined });
  const recovered = await restarted.recover(fixture.active.generation, prepared.transactionId, "roll-back");
  assert.equal(recovered.snapshot.changeSet?.status, "reviewing");
  await assert.rejects(lstat(path.join(fixture.sourceRoot, "src")), /ENOENT/);
});

test("rollback preserves planned directories that appeared externally after prepare", async (context) => {
  let stopOnce = true;
  const fixture = await createFixture(context, {}, {
    onTransactionPhase: (phase) => {
      if (phase === "file-source-durable" && stopOnce) {
        stopOnce = false;
        throw new Error("simulated termination after durable source replacement");
      }
    },
  });
  const runtimeFile = path.join(fixture.workspace.runtimePath, "src/generated/app.txt");
  await mkdir(path.dirname(runtimeFile), { recursive: true });
  await writeFile(runtimeFile, "generated\n");
  const selected = await scanAndSelectAll(fixture);
  const prepared = await fixture.service.prepareApply(
    fixture.active.generation,
    selected.changeSetId,
    selected.revision,
  );
  assert.equal(prepared.status, "prepared");
  assert.ok(prepared.transactionId && prepared.planDigest);

  const externalDirectory = path.join(fixture.sourceRoot, "src/generated");
  await mkdir(externalDirectory, { recursive: true });
  const interrupted = await fixture.service.commitApply(
    fixture.active.generation,
    prepared.transactionId,
    prepared.planDigest,
  );
  assert.equal(interrupted.snapshot.changeSet?.recovery?.actionRequired, true);
  assert.equal(await readFile(path.join(externalDirectory, "app.txt"), "utf8"), "generated\n");

  const restarted = new ChangeService({ ...fixture.dependencies, onTransactionPhase: undefined });
  const recovered = await restarted.recover(
    fixture.active.generation,
    prepared.transactionId,
    "roll-back",
  );
  assert.equal(recovered.snapshot.changeSet?.status, "reviewing");
  await assert.rejects(lstat(path.join(externalDirectory, "app.txt")), /ENOENT/);
  assert.equal((await lstat(externalDirectory)).isDirectory(), true);
  assert.equal((await lstat(path.join(fixture.sourceRoot, "src"))).isDirectory(), true);
});

test("rejects stale generations and instance changes without touching source", async (context) => {
  const fixture = await createFixture(context, { "src/app.txt": "before\n" });
  await writeFile(path.join(fixture.workspace.runtimePath, "src/app.txt"), "after\n");
  const selected = await scanAndSelectAll(fixture);
  const prepared = await fixture.service.prepareApply(
    fixture.active.generation,
    selected.changeSetId,
    selected.revision,
  );
  assert.equal(prepared.status, "prepared");
  assert.ok(prepared.transactionId && prepared.planDigest);

  await assert.rejects(
    fixture.service.commitApply(fixture.active.generation + 1, prepared.transactionId, prepared.planDigest),
    /stale generation/,
  );
  fixture.active.generation += 1;
  await assert.rejects(
    fixture.service.commitApply(fixture.active.generation, prepared.transactionId, prepared.planDigest),
    /does not belong to the active project or plan/,
  );
  fixture.active.identity.instanceKey = "different-instance";
  await assert.rejects(
    fixture.service.commitApply(fixture.active.generation, prepared.transactionId, prepared.planDigest),
    /journal cannot be synthesized|Transaction journal is missing|ENOENT/,
  );
  assert.equal(await readFile(path.join(fixture.sourceRoot, "src/app.txt"), "utf8"), "before\n");
});

test("holds the project-switch guard while final source authorization is pending", async (context) => {
  const fixture = await createFixture(context, { "src/app.txt": "before\n" });
  await writeFile(path.join(fixture.workspace.runtimePath, "src/app.txt"), "after\n");
  const selected = await scanAndSelectAll(fixture);
  const prepared = await fixture.service.prepareApply(
    fixture.active.generation,
    selected.changeSetId,
    selected.revision,
  );
  assert.equal(prepared.status, "prepared");
  assert.ok(prepared.transactionId && prepared.planDigest);

  let continueAuthorization!: () => void;
  let authorizationStarted!: () => void;
  const authorizationGate = new Promise<void>((resolve) => { continueAuthorization = resolve; });
  const authorizationEntered = new Promise<void>((resolve) => { authorizationStarted = resolve; });
  const baseProjects = fixture.dependencies.projects;
  const service = new ChangeService({
    ...fixture.dependencies,
    projects: {
      activeForChanges: (generation) => baseProjects.activeForChanges(generation),
      authorizeSourceOperation: async (generation, instanceKey) => {
        authorizationStarted();
        await authorizationGate;
        return baseProjects.authorizeSourceOperation(generation, instanceKey);
      },
    },
  });
  const committing = service.commitApply(
    fixture.active.generation,
    prepared.transactionId,
    prepared.planDigest,
  );
  await authorizationEntered;
  assert.equal(fixture.activity.hasActiveSession(), true);
  await assert.rejects(fixture.activity.stopForProjectSwitch(), /Finish or recover/);
  continueAuthorization();
  const committed = await committing;
  assert.equal(committed.snapshot.changeSet?.status, "applied");
  assert.equal(fixture.activity.hasActiveSession(), false);
});

test("reconciles a terminal journal when completion was durable before the ChangeSet pointer", async (context) => {
  let interruptOnce = true;
  const fixture = await createFixture(context, { "src/app.txt": "before\n" }, {
    onTransactionPhase: (phase) => {
      if (phase === "commit-completed" && interruptOnce) {
        interruptOnce = false;
        throw new Error("simulated termination after the journal committed");
      }
    },
  });
  await writeFile(path.join(fixture.workspace.runtimePath, "src/app.txt"), "after\n");
  const selected = await scanAndSelectAll(fixture);
  const prepared = await fixture.service.prepareApply(
    fixture.active.generation,
    selected.changeSetId,
    selected.revision,
  );
  assert.equal(prepared.status, "prepared");
  assert.ok(prepared.transactionId && prepared.planDigest);
  const interrupted = await fixture.service.commitApply(
    fixture.active.generation,
    prepared.transactionId,
    prepared.planDigest,
  );
  assert.notEqual(interrupted.snapshot.changeSet?.status, "applied");

  const restarted = new ChangeService({ ...fixture.dependencies, onTransactionPhase: undefined });
  const reconciled = await restarted.commitApply(
    fixture.active.generation,
    prepared.transactionId,
    prepared.planDigest,
  );
  assert.equal(reconciled.snapshot.changeSet?.status, "applied");
  assert.equal(reconciled.snapshot.changeSet?.recovery?.actionRequired, false);
  assert.equal(await readFile(path.join(fixture.sourceRoot, "src/app.txt"), "utf8"), "after\n");
});

test("reopens safely after real SIGKILL at every durable transaction boundary", {
  skip: process.platform === "win32" ? "SIGKILL crash semantics are POSIX-only." : false,
}, async (context) => {
  await context.test("journal-prepared", async (phaseContext) => {
    const fixture = await createFixture(phaseContext, { "src/app.txt": "before\n" });
    await writeFile(path.join(fixture.workspace.runtimePath, "src/app.txt"), "after\n");
    await runCrashChild(fixture, "prepare", "journal-prepared");

    const restarted = new ChangeService(fixture.dependencies);
    const restored = await restarted.snapshot(fixture.active.generation);
    assert.equal(restored.changeSet?.status, "reviewing");
    assert.equal(await readFile(path.join(fixture.sourceRoot, "src/app.txt"), "utf8"), "before\n");
    const rescanned = await restarted.scan(fixture.active.generation);
    assert.equal(rescanned.snapshot.changeSet?.files.length, 1);
  });

  const commitPhases = [
    "commit-started",
    "directories-recorded",
    "file-intent-recorded",
    "file-source-durable",
    "file-state-recorded",
    "commit-completed",
  ] as const;
  for (const phase of commitPhases) {
    await context.test(phase, async (phaseContext) => {
      const addition = phase === "directories-recorded";
      const fixture = await createFixture(
        phaseContext,
        addition ? {} : { "src/app.txt": "before\n" },
      );
      const relativePath = addition ? "src/generated/app.txt" : "src/app.txt";
      const runtimeFile = path.join(fixture.workspace.runtimePath, relativePath);
      await mkdir(path.dirname(runtimeFile), { recursive: true });
      await writeFile(runtimeFile, "after\n");
      const selected = await scanAndSelectAll(fixture);
      const prepared = await fixture.service.prepareApply(
        fixture.active.generation,
        selected.changeSetId,
        selected.revision,
      );
      assert.equal(prepared.status, "prepared");
      assert.ok(prepared.transactionId && prepared.planDigest);
      await runCrashChild(fixture, "commit", phase, {
        transactionId: prepared.transactionId,
        planDigest: prepared.planDigest,
      });

      const restarted = new ChangeService(fixture.dependencies);
      let restored = await restarted.snapshot(fixture.active.generation);
      if (phase === "commit-completed") {
        assert.equal(restored.changeSet?.status, "applied");
      } else {
        assert.equal(restored.changeSet?.recovery?.actionRequired, true);
        const recovered = await restarted.recover(
          fixture.active.generation,
          prepared.transactionId,
          "roll-forward",
        );
        restored = recovered.snapshot;
      }
      assert.equal(restored.changeSet?.status, "applied");
      const sourceFile = path.join(fixture.sourceRoot, relativePath);
      assert.equal(await readFile(sourceFile, "utf8"), "after\n");
      assert.equal((await readdir(path.dirname(sourceFile))).some((name) => name.includes(".larger-")), false);
    });
  }

  for (const phase of ["recovery-started", "recovery-completed"] as const) {
    await context.test(phase, async (phaseContext) => {
      let interruptCommit = true;
      const fixture = await createFixture(phaseContext, { "src/app.txt": "before\n" }, {
        onTransactionPhase: (currentPhase) => {
          if (currentPhase === "commit-started" && interruptCommit) {
            interruptCommit = false;
            throw new Error("prepare a recoverable transaction");
          }
        },
      });
      await writeFile(path.join(fixture.workspace.runtimePath, "src/app.txt"), "after\n");
      const selected = await scanAndSelectAll(fixture);
      const prepared = await fixture.service.prepareApply(
        fixture.active.generation,
        selected.changeSetId,
        selected.revision,
      );
      assert.equal(prepared.status, "prepared");
      assert.ok(prepared.transactionId && prepared.planDigest);
      const interrupted = await fixture.service.commitApply(
        fixture.active.generation,
        prepared.transactionId,
        prepared.planDigest,
      );
      assert.equal(interrupted.snapshot.changeSet?.recovery?.actionRequired, true);

      await runCrashChild(fixture, "recover", phase, {
        transactionId: prepared.transactionId,
        planDigest: prepared.planDigest,
      });
      const restarted = new ChangeService({ ...fixture.dependencies, onTransactionPhase: undefined });
      let restored = await restarted.snapshot(fixture.active.generation);
      if (phase === "recovery-started") {
        assert.equal(restored.changeSet?.recovery?.actionRequired, true);
        restored = (await restarted.recover(
          fixture.active.generation,
          prepared.transactionId,
          "roll-forward",
        )).snapshot;
      }
      assert.equal(restored.changeSet?.status, "applied");
      assert.equal(await readFile(path.join(fixture.sourceRoot, "src/app.txt"), "utf8"), "after\n");
    });
  }
});
