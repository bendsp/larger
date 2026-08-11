import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DependencyMaterializer } from "./materializer.js";
import { DependencySnapshotRepository } from "./snapshot-repository.js";
import type { DependencySnapshotKey, ResolvedDependencyPlan } from "./types.js";
import { dependencySnapshotIdentity } from "./identity.js";

async function makeWritable(root: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(root);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(root, 0o700);
    for (const child of await readdir(root)) await makeWritable(path.join(root, child));
  } else {
    await chmod(root, 0o600);
  }
}

function plan(): ResolvedDependencyPlan {
  const key: DependencySnapshotKey = {
    formatVersion: 1,
    packageManager: "pnpm",
    packageManagerVersion: "10.32.1",
    packageManagerExecutableSha256: "a".repeat(64),
    installRootRelativePath: ".",
    lockfilePath: "pnpm-lock.yaml",
    lockfileSha256: "b".repeat(64),
    installInputsSha256: "c".repeat(64),
    sourceBaselineIdentity: "d".repeat(64),
    runtime: {
      name: "node",
      version: "v24.0.0",
      modulesAbi: "137",
      napi: "10",
      platform: process.platform,
      architecture: process.arch,
    },
    installPolicySha256: "d".repeat(64),
    materializerVersion: "dependency-materializer-v1",
  };
  return {
    identity: dependencySnapshotIdentity(key),
    key,
    managerExecutable: "/not-used/pnpm",
    installRootRelativePath: ".",
    inputFiles: [],
  };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-dependency-repository-"));
  t.after(async () => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const runtimeRoot = path.join(root, "install-runtime");
  const nodeModulesPath = path.join(runtimeRoot, "node_modules");
  const sharedStoreFile = path.join(root, "shared-store-file");
  await mkdir(path.join(nodeModulesPath, "package"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "workspace"));
  await writeFile(sharedStoreFile, "export default 1;\n");
  await link(sharedStoreFile, path.join(nodeModulesPath, "package", "index.js"));
  await writeFile(path.join(runtimeRoot, "workspace", "index.js"), "workspace\n");
  await symlink("package", path.join(nodeModulesPath, "package-link"));
  await symlink("../workspace", path.join(nodeModulesPath, "workspace-link"));
  const options = { userDataPath: path.join(root, "user-data"), localInstanceKey: "dependency-tests" };
  return {
    root,
    runtimeRoot,
    nodeModulesPath,
    sharedStoreFile,
    options,
    repository: await DependencySnapshotRepository.open(options),
  };
}

test("snapshot publication stores private files and symlink metadata only", async (t) => {
  const { repository, runtimeRoot, nodeModulesPath, sharedStoreFile } = await fixture(t);
  const result = await repository.ensure(plan(), async () => ({ runtimeRoot, nodeModulesPath }));
  assert.equal(result.cacheHit, false);
  assert.equal(await readFile(path.join(result.snapshot.treePath, "package", "index.js"), "utf8"), "export default 1;\n");
  assert.equal((await lstat(path.join(result.snapshot.treePath, "package", "index.js"))).nlink, 1);
  await writeFile(sharedStoreFile, "mutated store\n");
  assert.equal(await readFile(path.join(result.snapshot.treePath, "package", "index.js"), "utf8"), "export default 1;\n");
  await assert.rejects(lstat(path.join(result.snapshot.treePath, "package-link")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(result.snapshot.treePath, "workspace-link")), { code: "ENOENT" });
  assert.equal(result.snapshot.manifest.entries.some((entry) => entry.type === "symlink" && entry.target.kind === "runtime-workspace"), true);
});

test("concurrent callers build one immutable snapshot and later calls are cache hits", async (t) => {
  const { repository, runtimeRoot, nodeModulesPath } = await fixture(t);
  let builds = 0;
  const build = async () => {
    builds += 1;
    await Promise.resolve();
    return { runtimeRoot, nodeModulesPath };
  };
  const [first, second] = await Promise.all([
    repository.ensure(plan(), build),
    repository.ensure(plan(), build),
  ]);
  assert.equal(builds, 1);
  assert.equal(first.snapshot.identity, second.snapshot.identity);
  const cached = await repository.ensure(plan(), async () => {
    throw new Error("cache hit must not rebuild");
  });
  assert.equal(cached.cacheHit, true);
});

test("a cancelled follower does not cancel the shared snapshot builder", async (t) => {
  const { repository, runtimeRoot, nodeModulesPath } = await fixture(t);
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  let builds = 0;
  const leader = repository.ensure(plan(), async () => {
    builds += 1;
    started();
    await releasePromise;
    return { runtimeRoot, nodeModulesPath };
  });
  await startedPromise;
  const controller = new AbortController();
  const follower = repository.ensure(plan(), async () => {
    throw new Error("follower must not build");
  }, { signal: controller.signal });
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(follower, { name: "AbortError" });
  release();
  assert.equal((await leader).cacheHit, false);
  assert.equal(builds, 1);
});

test("runtime materialization relocates links and never shares writable inodes", async (t) => {
  const { root, repository, runtimeRoot, nodeModulesPath } = await fixture(t);
  const snapshot = (await repository.ensure(plan(), async () => ({ runtimeRoot, nodeModulesPath }))).snapshot;
  const privateRuntime = path.join(root, "private-runtime");
  await mkdir(path.join(privateRuntime, "workspace"), { recursive: true });
  await writeFile(path.join(privateRuntime, "workspace", "index.js"), "private workspace\n");
  const materializer = new DependencyMaterializer();
  const first = await materializer.materialize(snapshot, privateRuntime, "runtime-a", ".");
  assert.equal(first.reusedCurrent, false);
  assert.equal(await readFile(path.join(privateRuntime, "node_modules", "workspace-link", "index.js"), "utf8"), "private workspace\n");
  const sourceStat = await lstat(path.join(snapshot.treePath, "package", "index.js"));
  const runtimeStat = await lstat(path.join(privateRuntime, "node_modules", "package", "index.js"));
  assert.notEqual(`${sourceStat.dev}:${sourceStat.ino}`, `${runtimeStat.dev}:${runtimeStat.ino}`);
  await writeFile(path.join(privateRuntime, "node_modules", "package", "index.js"), "changed\n");
  assert.equal(await readFile(path.join(snapshot.treePath, "package", "index.js"), "utf8"), "export default 1;\n");
  const restored = await materializer.materialize(snapshot, privateRuntime, "runtime-a", ".");
  assert.equal(restored.reusedCurrent, true);
});

test("snapshot tampering fails closed and abandoned staging is recovered", async (t) => {
  const { options, repository, runtimeRoot, nodeModulesPath, root } = await fixture(t);
  const snapshot = (await repository.ensure(plan(), async () => ({ runtimeRoot, nodeModulesPath }))).snapshot;
  const file = path.join(snapshot.treePath, "package", "index.js");
  await chmod(file, 0o600);
  await writeFile(file, "tampered\n");
  await assert.rejects(repository.load(snapshot.identity), /integrity failed|failed verification/);

  const abandoned = path.join(root, "user-data", "runtime-workspaces", "instances", "dependency-tests", "dependencies", "staging", "abandoned");
  const live = path.join(root, "user-data", "runtime-workspaces", "instances", "dependency-tests", "dependencies", "staging", `operation-${process.pid}-11111111-1111-4111-8111-111111111111`);
  await mkdir(abandoned);
  await writeFile(path.join(abandoned, "partial"), "partial");
  await mkdir(live);
  await writeFile(path.join(live, "active"), "active");
  await DependencySnapshotRepository.open(options);
  await assert.rejects(lstat(abandoned), { code: "ENOENT" });
  assert.equal((await lstat(live)).isDirectory(), true);
});
