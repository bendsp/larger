import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { describeDependencyCache } from "./dependency-cache.js";
import {
  CopyOnWriteMaterializer,
  FallbackMaterializer,
  PortableCopyMaterializer,
} from "./materializers.js";
import { RuntimeWorkspaceProvider } from "./provider.js";
import { createWorkspacePaths, WorkspaceSecurityError } from "./security.js";
import type {
  BaselineManifest,
  MaterializationBackend,
  StagingPhase,
} from "./types.js";
import { SourceMutationError, UnsupportedSourceEntryError, verifyBaselineTree } from "./inventory.js";

const execFileAsync = promisify(execFile);

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "larger-workspaces-test-"));
  t.after(async () => {
    await makeTestTreeWritable(directory);
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function makeTestTreeWritable(root: string): Promise<void> {
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch {
    return;
  }
  if (rootStat.isSymbolicLink()) return;
  if (!rootStat.isDirectory()) {
    await chmod(root, 0o600);
    return;
  }
  await chmod(root, 0o700);
  for (const child of await readdir(root)) await makeTestTreeWritable(path.join(root, child));
}

async function createFixture(root: string): Promise<void> {
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await writeFile(path.join(root, "src", "message.txt"), "local dirty work\n");
  await writeFile(path.join(root, "src", "binary.bin"), Buffer.from([0, 255, 17, 32]));
  await writeFile(path.join(root, "src", "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(path.join(root, "src", "nested", "untracked.ts"), "export const local = true;\n");
  await symlink("message.txt", path.join(root, "src", "message-link"));
  for (const included of ["src/build", "fixtures/dist", "packages/app/out", "examples/coverage", ".yarn/patches"]) {
    await mkdir(path.join(root, included), { recursive: true });
    await writeFile(path.join(root, included, "source.txt"), `${included}\n`);
  }
  for (const nestedCache of ["apps/web/.next", "packages/ui/.turbo"]) {
    await mkdir(path.join(root, nestedCache), { recursive: true });
    await writeFile(path.join(root, nestedCache, "generated.txt"), "generated cache");
  }
  for (const excludedYarnState of [".yarn/unplugged/package", ".yarn/install-state.gz"]) {
    const target = path.join(root, excludedYarnState);
    if (path.extname(target)) {
      await writeFile(target, "generated yarn state");
    } else {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "generated.txt"), "generated yarn state");
    }
  }
  for (const excluded of [".git", ".larger", "node_modules", ".next", "dist", "coverage"]) {
    await mkdir(path.join(root, excluded), { recursive: true });
    await writeFile(path.join(root, excluded, "ignored"), excluded);
  }
}

async function assertFixtureRuntime(runtimePath: string): Promise<void> {
  assert.equal(await readFile(path.join(runtimePath, "src", "message.txt"), "utf8"), "local dirty work\n");
  assert.deepEqual(await readFile(path.join(runtimePath, "src", "binary.bin")), Buffer.from([0, 255, 17, 32]));
  assert.equal((await lstat(path.join(runtimePath, "src", "run.sh"))).mode & 0o111, 0o111);
  assert.equal(await readlink(path.join(runtimePath, "src", "message-link")), "message.txt");
  for (const included of ["src/build", "fixtures/dist", "packages/app/out", "examples/coverage", ".yarn/patches"]) {
    assert.equal(await readFile(path.join(runtimePath, included, "source.txt"), "utf8"), `${included}\n`);
  }
  await assert.rejects(lstat(path.join(runtimePath, ".yarn", "unplugged")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(runtimePath, ".yarn", "install-state.gz")), { code: "ENOENT" });
  for (const nestedCache of ["apps/web/.next", "packages/ui/.turbo"]) {
    await assert.rejects(lstat(path.join(runtimePath, nestedCache)), { code: "ENOENT" });
  }
  for (const excluded of [".git", ".larger", "node_modules", ".next", "dist", "coverage"]) {
    await assert.rejects(lstat(path.join(runtimePath, excluded)), { code: "ENOENT" });
  }
}

function provider(userDataPath: string, key: string, materializer?: MaterializationBackend): RuntimeWorkspaceProvider {
  return new RuntimeWorkspaceProvider({ userDataPath, localInstanceKey: key, materializer });
}

test("captures ordinary dirty, untracked, binary, executable, and internal symlink content", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  const userData = path.join(temporary, "user-data");
  await mkdir(source);
  await createFixture(source);
  const beforeNames = await readdir(source);

  const workspace = await provider(userData, "checkout-a", new PortableCopyMaterializer()).stage(source);

  await assertFixtureRuntime(workspace.runtimePath);
  assert.deepEqual(await readdir(source), beforeNames);
  assert.equal(await readFile(path.join(source, "src", "message.txt"), "utf8"), "local dirty work\n");
  await writeFile(path.join(workspace.runtimePath, "src", "message.txt"), "runtime edit\n");
  assert.equal(
    await readFile(path.join(workspace.baselinePath, "tree", "src", "message.txt"), "utf8"),
    "local dirty work\n",
  );
  assert.ok(workspace.manifest.entries.some((entry) => entry.path === "src/message-link" && entry.type === "symlink"));
  assert.equal(workspace.manifest.entries.filter((entry) => entry.path.includes("message-link/")).length, 0);
  assert.equal((await lstat(path.join(workspace.baselinePath, "manifest.json"))).mode & 0o222, 0);
  assert.equal((await lstat(path.join(workspace.baselinePath, "tree", "src", "message.txt"))).mode & 0o222, 0);
});

test("resetCurrent replaces edited runtime from its immutable baseline", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  const userData = path.join(temporary, "user-data");
  await mkdir(source);
  await createFixture(source);
  const runtimeProvider = provider(userData, "reset-runtime", new PortableCopyMaterializer());
  const first = await runtimeProvider.stage(source);
  await writeFile(path.join(first.runtimePath, "src", "message.txt"), "discard me\n");
  const reset = await runtimeProvider.resetCurrent();
  assert.notEqual(reset.runtimeId, first.runtimeId);
  assert.equal(reset.baselineIdentity, first.baselineIdentity);
  assert.equal(await readFile(path.join(reset.runtimePath, "src", "message.txt"), "utf8"), "local dirty work\n");
  assert.equal((await runtimeProvider.current())?.runtimeId, reset.runtimeId);
  await assert.rejects(lstat(first.runtimePath), { code: "ENOENT" });
});

test("baseline verification streams large files and can cancel between chunks", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  const userData = path.join(temporary, "user-data");
  await mkdir(source);
  const fileSize = 2 * 1024 * 1024;
  await writeFile(path.join(source, "large.bin"), Buffer.alloc(fileSize, 0x5a));
  const workspace = await provider(userData, "stream-verification", new PortableCopyMaterializer()).stage(source);
  const controller = new AbortController();
  let observedBytes = 0;

  await assert.rejects(
    verifyBaselineTree(
      path.join(workspace.baselinePath, "tree"),
      workspace.manifest,
      controller.signal,
      (_relativePath, bytesRead) => {
        observedBytes = bytesRead;
        controller.abort(new Error("cancelled during file verification"));
      },
    ),
    (error: unknown) => {
      assert.equal((error as Error).name, "AbortError");
      assert.match(String((error as Error & { cause?: unknown }).cause), /cancelled during file verification/);
      return true;
    },
  );
  assert.ok(observedBytes > 0);
  assert.ok(observedBytes < fileSize);
});

async function materializerConformance(
  t: test.TestContext,
  label: string,
  materializer: MaterializationBackend,
): Promise<{ manifest: BaselineManifest; runtimePath: string }> {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  await mkdir(source);
  await createFixture(source);
  const result = await provider(path.join(temporary, "user-data"), label, materializer).stage(source);
  await assertFixtureRuntime(result.runtimePath);
  assert.equal((await lstat(path.join(result.runtimePath, "src", "message.txt"))).mode & 0o200, 0o200);
  return { manifest: result.manifest, runtimePath: result.runtimePath };
}

test("copy-on-write and portable backends satisfy the same conformance contract", async (t) => {
  const portable = await materializerConformance(t, "portable", new PortableCopyMaterializer());
  let clone: Awaited<ReturnType<typeof materializerConformance>>;
  try {
    clone = await materializerConformance(t, "clone", new CopyOnWriteMaterializer());
  } catch (error) {
    if (new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EINVAL", "EXDEV"]).has((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("copy-on-write cloning is unavailable on this filesystem");
      return;
    }
    throw error;
  }
  assert.equal(clone.manifest.identity, portable.manifest.identity);
  assert.deepEqual(clone.manifest.entries, portable.manifest.entries);
});

test("fallback backend removes a partial clone and produces a conforming runtime", async (t) => {
  class UnsupportedPartialClone implements MaterializationBackend {
    readonly name = "unsupported-partial-clone";
    async materialize(_baseline: string, destination: string): Promise<void> {
      await mkdir(destination);
      await writeFile(path.join(destination, "partial"), "must disappear");
      const error = new Error("clone unsupported") as NodeJS.ErrnoException;
      error.code = "ENOTSUP";
      throw error;
    }
  }

  const result = await materializerConformance(
    t,
    "fallback",
    new FallbackMaterializer(new UnsupportedPartialClone(), new PortableCopyMaterializer()),
  );
  await assert.rejects(lstat(path.join(result.runtimePath, "partial")), { code: "ENOENT" });
});

test("external and dangling symlinks fail closed while internal links are relocated", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  const outside = path.join(temporary, "outside.txt");
  await mkdir(source);
  await writeFile(outside, "outside");
  await symlink(outside, path.join(source, "external"));
  await assert.rejects(
    provider(path.join(temporary, "user-data"), "external").stage(source),
    (error: unknown) => error instanceof UnsupportedSourceEntryError && /external symlinks/.test(error.message),
  );
  await rm(path.join(source, "external"));
  await symlink("missing", path.join(source, "dangling"));
  await assert.rejects(
    provider(path.join(temporary, "user-data"), "dangling").stage(source),
    (error: unknown) => error instanceof UnsupportedSourceEntryError && /dangling symlinks/.test(error.message),
  );
});

test("special files are rejected rather than copied or followed", { skip: process.platform === "win32" }, async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  await mkdir(source);
  const fifo = path.join(source, "events.fifo");
  await execFileAsync("mkfifo", [fifo]);
  await assert.rejects(
    provider(path.join(temporary, "user-data"), "special").stage(source),
    (error: unknown) => error instanceof UnsupportedSourceEntryError && /special files/.test(error.message),
  );
});

test("a Unix socket is rejected without connecting to it", { skip: process.platform === "win32" }, async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  await mkdir(source);
  const socketPath = path.join(source, "server.sock");
  const server = net.createServer();
  server.listen(socketPath);
  await once(server, "listening");
  t.after(() => server.close());
  await assert.rejects(provider(path.join(temporary, "user-data"), "socket").stage(source), UnsupportedSourceEntryError);
});

test("canonical storage parents cannot be replaced with escaping symlinks", async (t) => {
  const temporary = await temporaryDirectory(t);
  const userData = path.join(temporary, "user-data");
  const outside = path.join(temporary, "outside");
  await mkdir(userData);
  await mkdir(outside);
  await symlink(outside, path.join(userData, "runtime-workspaces"));
  await assert.rejects(createWorkspacePaths(userData, "checkout"), WorkspaceSecurityError);
  await assert.rejects(createWorkspacePaths(userData, "../escape"), WorkspaceSecurityError);
});

test("source mutation between inventory and validation rejects the torn snapshot", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  await mkdir(source);
  await writeFile(path.join(source, "page.tsx"), "first");
  await assert.rejects(
    provider(path.join(temporary, "user-data"), "mutation").stage(source, {
      onPhase: async (phase) => {
        if (phase === "inventory-complete") await writeFile(path.join(source, "page.tsx"), "second");
      },
    }),
    SourceMutationError,
  );
});

test("source and managed runtime storage cannot contain one another", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  const nestedUserData = path.join(source, "user-data");
  await mkdir(source);
  await assert.rejects(provider(nestedUserData, "overlap").stage(source), WorkspaceSecurityError);

  const managedUserData = path.join(temporary, "managed-user-data");
  const paths = await createWorkspacePaths(managedUserData, "overlap");
  await assert.rejects(provider(managedUserData, "overlap").stage(paths.stagingRoot), WorkspaceSecurityError);
});

test("cancellation at every pre-publication phase preserves the previous workspace", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  const userData = path.join(temporary, "user-data");
  await mkdir(source);
  await writeFile(path.join(source, "value.txt"), "one");
  const runtimeProvider = provider(userData, "cancel");
  const initial = await runtimeProvider.stage(source);

  const cancellablePhases: StagingPhase[] = [
    "inventory-started",
    "inventory-progress",
    "inventory-complete",
    "source-validated",
    "baseline-prepared",
    "baseline-installed",
    "runtime-materialized",
    "runtime-installed",
    "before-publication",
  ];
  for (const phaseToCancel of cancellablePhases) {
    await writeFile(path.join(source, "value.txt"), `changed at ${phaseToCancel}`);
    const controller = new AbortController();
    await assert.rejects(
      runtimeProvider.stage(source, {
        signal: controller.signal,
        onPhase: (phase) => {
          if (phase === phaseToCancel) controller.abort(new Error(`cancelled at ${phase}`));
        },
      }),
      /cancelled at/,
    );
    const current = await runtimeProvider.current();
    assert.equal(current?.runtimeId, initial.runtimeId);
    assert.equal(await readFile(path.join(initial.runtimePath, "value.txt"), "utf8"), "one");
    assert.equal(await readFile(path.join(initial.baselinePath, "tree", "value.txt"), "utf8"), "one");
    const paths = await createWorkspacePaths(userData, "cancel");
    assert.deepEqual(await readdir(paths.runtimesRoot), [initial.runtimeId]);
  }
});

test("a late abort during durable pointer writing cannot publish the cancelled runtime", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  const userData = path.join(temporary, "user-data");
  await mkdir(source);
  const valuePath = path.join(source, "value.txt");
  await writeFile(valuePath, "one");
  const runtimeProvider = provider(userData, "late-cancel");
  const first = await runtimeProvider.stage(source);
  await writeFile(valuePath, "two");
  const controller = new AbortController();
  await assert.rejects(runtimeProvider.stage(source, {
    signal: controller.signal,
    onPhase: (phase) => {
      if (phase === "before-publication") {
        setImmediate(() => controller.abort(new Error("late abort")));
      }
    },
  }), /late abort/);
  const current = await runtimeProvider.current();
  assert.equal(current?.runtimeId, first.runtimeId);
  assert.equal(await readFile(path.join(current!.runtimePath, "value.txt"), "utf8"), "one");
});

test("identity is deterministic for equivalent trees in independent instances", async (t) => {
  const temporary = await temporaryDirectory(t);
  const sourceA = path.join(temporary, "source-a");
  const sourceB = path.join(temporary, "source-b");
  await mkdir(sourceA);
  await mkdir(sourceB);
  await createFixture(sourceA);
  await createFixture(sourceB);
  const userData = path.join(temporary, "user-data");
  const first = await provider(userData, "deterministic-a", new PortableCopyMaterializer()).stage(sourceA);
  const second = await provider(userData, "deterministic-b", new PortableCopyMaterializer()).stage(sourceB);
  assert.equal(first.baselineIdentity, second.baselineIdentity);
  assert.deepEqual(first.manifest.entries, second.manifest.entries);
});

test("local instances and their current pointers are isolated", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  const userData = path.join(temporary, "user-data");
  await mkdir(source);
  await writeFile(path.join(source, "value.txt"), "shared source");
  const firstProvider = provider(userData, "instance-a");
  const secondProvider = provider(userData, "instance-b");
  const [first, second] = await Promise.all([firstProvider.stage(source), secondProvider.stage(source)]);
  assert.equal(first.baselineIdentity, second.baselineIdentity);
  assert.notEqual(first.baselinePath, second.baselinePath);
  assert.notEqual(first.runtimePath, second.runtimePath);
  assert.equal((await firstProvider.current())?.runtimeId, first.runtimeId);
  assert.equal((await secondProvider.current())?.runtimeId, second.runtimeId);
});

test("old immutable baselines survive later publications", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  await mkdir(source);
  const file = path.join(source, "value.txt");
  await writeFile(file, "one");
  const runtimeProvider = provider(path.join(temporary, "user-data"), "survival");
  const first = await runtimeProvider.stage(source);
  await writeFile(file, "two");
  const second = await runtimeProvider.stage(source);
  assert.notEqual(first.baselineIdentity, second.baselineIdentity);
  assert.equal(await readFile(path.join(first.baselinePath, "tree", "value.txt"), "utf8"), "one");
  assert.equal((await runtimeProvider.current())?.runtimeId, second.runtimeId);
  await rm(second.runtimePath, { recursive: true });
  assert.equal(await readFile(path.join(second.baselinePath, "tree", "value.txt"), "utf8"), "two");
});

test("an identical source reuses its verified baseline and publishes a fresh runtime", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  await mkdir(source);
  await writeFile(path.join(source, "value.txt"), "same");
  const runtimeProvider = provider(path.join(temporary, "user-data"), "reuse");
  const first = await runtimeProvider.stage(source);
  const second = await runtimeProvider.stage(source);
  assert.equal(first.baselineIdentity, second.baselineIdentity);
  assert.equal(first.baselinePath, second.baselinePath);
  assert.notEqual(first.runtimeId, second.runtimeId);
  assert.equal(await readFile(path.join(second.runtimePath, "value.txt"), "utf8"), "same");
});

test("baseline tampering is detected before it can be trusted", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  await mkdir(source);
  await writeFile(path.join(source, "value.txt"), "trusted");
  const runtimeProvider = provider(path.join(temporary, "user-data"), "tamper");
  const workspace = await runtimeProvider.stage(source);
  const baselineFile = path.join(workspace.baselinePath, "tree", "value.txt");
  await chmod(baselineFile, 0o600);
  await writeFile(baselineFile, "tampered");
  await assert.rejects(runtimeProvider.current(), /integrity check failed/);
});

test("stored manifests cannot redirect materialized symlinks outside the runtime", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  await mkdir(source);
  await createFixture(source);
  const runtimeProvider = provider(path.join(temporary, "user-data"), "symlink-tamper");
  const workspace = await runtimeProvider.stage(source);
  await makeTestTreeWritable(workspace.baselinePath);
  const manifestPath = path.join(workspace.baselinePath, "manifest.json");
  const stored = JSON.parse(await readFile(manifestPath, "utf8")) as BaselineManifest;
  const entries = stored.entries.map((entry) => entry.type === "symlink"
    ? { ...entry, materializedTarget: "../../outside" }
    : entry);
  await writeFile(manifestPath, `${JSON.stringify({ ...stored, entries }, null, 2)}\n`);
  await assert.rejects(runtimeProvider.current(), WorkspaceSecurityError);
});

test("current workspace rejects symlinked pointer, baseline, and runtime leaves", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = path.join(temporary, "source");
  const userData = path.join(temporary, "user-data");
  const outside = path.join(temporary, "outside");
  await mkdir(source);
  await mkdir(outside);
  await writeFile(path.join(source, "value.txt"), "trusted");

  const pointerProvider = provider(userData, "pointer-link");
  await pointerProvider.stage(source);
  const pointerPaths = await createWorkspacePaths(userData, "pointer-link");
  await rm(pointerPaths.currentPointerPath);
  await symlink(path.join(outside, "pointer.json"), pointerPaths.currentPointerPath);
  await writeFile(path.join(outside, "pointer.json"), "{}\n");
  await assert.rejects(pointerProvider.current(), WorkspaceSecurityError);

  const baselineProvider = provider(userData, "baseline-link");
  const baselineWorkspace = await baselineProvider.stage(source);
  await makeTestTreeWritable(baselineWorkspace.baselinePath);
  await rm(baselineWorkspace.baselinePath, { recursive: true });
  await symlink(outside, baselineWorkspace.baselinePath, "dir");
  await assert.rejects(baselineProvider.current(), /missing workspace data/);

  const runtimeProvider = provider(userData, "runtime-link");
  const runtimeWorkspace = await runtimeProvider.stage(source);
  await rm(runtimeWorkspace.runtimePath, { recursive: true });
  await symlink(outside, runtimeWorkspace.runtimePath, "dir");
  await assert.rejects(runtimeProvider.current(), /missing workspace data/);
});

test("dependency cache identity is deterministic and promises no shared writable node_modules", () => {
  const key = {
    packageManager: "pnpm" as const,
    lockfileSha256: "a".repeat(64),
    runtime: "node-24.5.0",
    platform: process.platform,
    architecture: process.arch,
    toolchainVersion: "pnpm-10.32.1",
  };
  const first = describeDependencyCache(key);
  const second = describeDependencyCache({ ...key });
  const changed = describeDependencyCache({ ...key, runtime: "node-24.6.0" });
  assert.equal(first.identity, second.identity);
  assert.notEqual(first.identity, changed.identity);
  assert.equal(first.sharing, "immutable-read-only");
  assert.equal(first.runtimeNodeModules, "private-writable");
});
