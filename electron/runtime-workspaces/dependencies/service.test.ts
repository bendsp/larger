import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeWorkspaceProvider } from "../provider.js";
import { UnsupportedDependencyManagerError } from "./errors.js";
import { resolveDependencyPlan } from "./planner.js";
import { DependencyService } from "./service.js";
import type { DependencyInstaller } from "./types.js";

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

class FixtureInstaller implements DependencyInstaller {
  calls = 0;

  constructor(private readonly beforeWrite?: (signal?: AbortSignal) => void) {}

  async install(
    _plan: Parameters<DependencyInstaller["install"]>[0],
    stagedProjectRoot: string,
    _operationStagingPath: string,
    options: Parameters<DependencyInstaller["install"]>[3] = {},
  ): Promise<void> {
    this.calls += 1;
    this.beforeWrite?.(options.signal);
    options.signal?.throwIfAborted();
    await mkdir(path.join(stagedProjectRoot, "node_modules", "fixture-package"), { recursive: true });
    await writeFile(path.join(stagedProjectRoot, "node_modules", "fixture-package", "index.js"), "fixture dependency\n");
  }
}

async function npmFixture(t: test.TestContext, instanceKey = "dependency-service") {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-dependency-service-"));
  t.after(async () => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "package.json"), JSON.stringify({
    name: "dependency-fixture",
    private: true,
  }, null, 2));
  await writeFile(path.join(source, "package-lock.json"), JSON.stringify({
    name: "dependency-fixture",
    lockfileVersion: 3,
    packages: { "": { name: "dependency-fixture" } },
  }, null, 2));
  const userDataPath = path.join(root, "user-data");
  return {
    root,
    source,
    userDataPath,
    instanceKey,
    provider: new RuntimeWorkspaceProvider({ userDataPath, localInstanceKey: instanceKey }),
  };
}

test("unchanged relaunch restores the current dependency installation without reinstalling", async (t) => {
  const fixture = await npmFixture(t);
  const installer = new FixtureInstaller();
  const service = await DependencyService.open({
    userDataPath: fixture.userDataPath,
    localInstanceKey: fixture.instanceKey,
    installer,
  });
  const first = await fixture.provider.stage(fixture.source, {
    prepareRuntime: service.createPreparationHook({ packageManager: "npm" }),
  });
  assert.equal(installer.calls, 1);
  assert.equal(await readFile(path.join(first.runtimePath, "node_modules", "fixture-package", "index.js"), "utf8"), "fixture dependency\n");

  const relaunched = await DependencyService.open({
    userDataPath: fixture.userDataPath,
    localInstanceKey: fixture.instanceKey,
    installer: new FixtureInstaller(),
  });
  const restoredWorkspace = await fixture.provider.current();
  assert.ok(restoredWorkspace);
  const restored = await relaunched.restoreCurrent(restoredWorkspace, { packageManager: "npm" });
  assert.equal(restored?.reusedCurrent, true);
  assert.equal(installer.calls, 1);
});

test("a fresh runtime reuses the immutable snapshot without reinstalling", async (t) => {
  const fixture = await npmFixture(t, "dependency-reuse");
  const firstInstaller = new FixtureInstaller();
  const firstService = await DependencyService.open({
    userDataPath: fixture.userDataPath,
    localInstanceKey: fixture.instanceKey,
    installer: firstInstaller,
  });
  const first = await fixture.provider.stage(fixture.source, {
    prepareRuntime: firstService.createPreparationHook({ packageManager: "npm" }),
  });
  const secondInstaller = new FixtureInstaller();
  const secondService = await DependencyService.open({
    userDataPath: fixture.userDataPath,
    localInstanceKey: fixture.instanceKey,
    installer: secondInstaller,
  });
  const second = await fixture.provider.stage(fixture.source, {
    prepareRuntime: secondService.createPreparationHook({ packageManager: "npm" }),
  });
  assert.notEqual(first.runtimeId, second.runtimeId);
  assert.equal(firstInstaller.calls, 1);
  assert.equal(secondInstaller.calls, 0);
  assert.equal(await readFile(path.join(second.runtimePath, "node_modules", "fixture-package", "index.js"), "utf8"), "fixture dependency\n");
});

test("cancelled dependency installation preserves the previous runtime publication", async (t) => {
  const fixture = await npmFixture(t, "dependency-cancellation");
  const first = await fixture.provider.stage(fixture.source);
  const controller = new AbortController();
  const installer = new FixtureInstaller(() => controller.abort(new DOMException("cancelled", "AbortError")));
  const service = await DependencyService.open({
    userDataPath: fixture.userDataPath,
    localInstanceKey: fixture.instanceKey,
    installer,
  });
  await assert.rejects(fixture.provider.stage(fixture.source, {
    signal: controller.signal,
    prepareRuntime: service.createPreparationHook({ packageManager: "npm", signal: controller.signal }),
  }), { name: "AbortError" });
  assert.equal((await fixture.provider.current())?.runtimeId, first.runtimeId);
});

test("dependency identity includes package manifests beyond the lockfile", async (t) => {
  const fixture = await npmFixture(t, "dependency-identity");
  const first = await resolveDependencyPlan(fixture.source, { packageManager: "npm" });
  const packageJsonPath = path.join(fixture.source, "package.json");
  const manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  await writeFile(packageJsonPath, JSON.stringify({ ...manifest, scripts: { prepare: "node prepare.js" } }, null, 2));
  const second = await resolveDependencyPlan(fixture.source, { packageManager: "npm" });
  assert.notEqual(first.key.installInputsSha256, second.key.installInputsSha256);
  assert.notEqual(first.identity, second.identity);
  assert.equal(first.key.lockfileSha256, second.key.lockfileSha256);
});

test("dependency identity includes install-input executable modes", async (t) => {
  const fixture = await npmFixture(t, "dependency-mode-identity");
  const packageJsonPath = path.join(fixture.source, "package.json");
  const first = await resolveDependencyPlan(fixture.source, { packageManager: "npm" });
  await chmod(packageJsonPath, 0o744);
  const second = await resolveDependencyPlan(fixture.source, { packageManager: "npm" });
  assert.notEqual(first.key.installInputsSha256, second.key.installInputsSha256);
  assert.notEqual(first.identity, second.identity);
  assert.equal(first.key.lockfileSha256, second.key.lockfileSha256);
});

test("dependency identity is bound to the immutable source baseline", async (t) => {
  const fixture = await npmFixture(t, "dependency-baseline-identity");
  const first = await resolveDependencyPlan(fixture.source, {
    packageManager: "npm",
    sourceBaselineIdentity: "a".repeat(64),
  });
  const second = await resolveDependencyPlan(fixture.source, {
    packageManager: "npm",
    sourceBaselineIdentity: "b".repeat(64),
  });

  assert.equal(first.key.installInputsSha256, second.key.installInputsSha256);
  assert.notEqual(first.identity, second.identity);
});

test("Yarn PnP and Bun return typed unsupported errors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-unsupported-dependencies-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const yarn = path.join(root, "yarn");
  await mkdir(yarn);
  await writeFile(path.join(yarn, "package.json"), JSON.stringify({ packageManager: "yarn@4.0.0" }));
  await writeFile(path.join(yarn, "yarn.lock"), "__metadata:\n  version: 8\n");
  await writeFile(path.join(yarn, ".yarnrc.yml"), "nodeLinker: pnp\n");
  await assert.rejects(resolveDependencyPlan(yarn), (error: unknown) =>
    error instanceof UnsupportedDependencyManagerError && error.code === "yarn-pnp");

  const bun = path.join(root, "bun");
  await mkdir(bun);
  await writeFile(path.join(bun, "package.json"), JSON.stringify({ packageManager: "bun@1.0.0" }));
  await writeFile(path.join(bun, "bun.lock"), "{}");
  await assert.rejects(resolveDependencyPlan(bun), (error: unknown) =>
    error instanceof UnsupportedDependencyManagerError && error.code === "bun");
});

test("pnpm plans use the resolved toolchain and declared version mismatches fail closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-pnpm-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "pnpm-plan", private: true }));
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
  const resolved = await resolveDependencyPlan(root, { packageManager: "pnpm" });
  assert.equal(resolved.key.packageManager, "pnpm");
  assert.match(resolved.key.packageManagerVersion, /^\d+\.\d+\.\d+/);
  assert.match(resolved.key.packageManagerExecutableSha256, /^[a-f0-9]{64}$/);

  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "pnpm-plan",
    private: true,
    packageManager: "pnpm@0.0.0",
  }));
  await assert.rejects(resolveDependencyPlan(root), /requires pnpm@0\.0\.0/);
});
