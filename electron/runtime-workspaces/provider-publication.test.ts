import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeWorkspaceProvider } from "./provider.js";
import { createWorkspacePaths } from "./security.js";

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

async function fixture(t: test.TestContext): Promise<{ root: string; source: string; provider: RuntimeWorkspaceProvider }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-provider-publication-"));
  t.after(async () => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "package.json"), "{}\n");
  return {
    root,
    source,
    provider: new RuntimeWorkspaceProvider({
      userDataPath: path.join(root, "user-data"),
      localInstanceKey: "provider-publication",
    }),
  };
}

test("runtime preparation finishes before the current pointer is published", async (t) => {
  const { provider, source } = await fixture(t);
  const workspace = await provider.stage(source, {
    prepareRuntime: async (candidate) => {
      await writeFile(path.join(candidate.runtimePath, "prepared.txt"), candidate.runtimeId);
    },
  });
  assert.equal(await readFile(path.join(workspace.runtimePath, "prepared.txt"), "utf8"), workspace.runtimeId);
  assert.equal((await provider.current())?.runtimeId, workspace.runtimeId);
});

test("failed runtime preparation preserves the previous published workspace", async (t) => {
  const { provider, root, source } = await fixture(t);
  const first = await provider.stage(source);
  await assert.rejects(provider.stage(source, {
    prepareRuntime: async (candidate) => {
      await writeFile(path.join(candidate.runtimePath, "partial.txt"), "partial");
      throw new Error("dependency preparation failed");
    },
  }), /dependency preparation failed/);
  assert.equal((await provider.current())?.runtimeId, first.runtimeId);
  const paths = await createWorkspacePaths(path.join(root, "user-data"), "provider-publication");
  assert.deepEqual(await readdir(paths.stagingRoot), []);
});

test("cancellation after runtime preparation preserves the previous workspace", async (t) => {
  const { provider, source } = await fixture(t);
  const first = await provider.stage(source);
  const controller = new AbortController();
  await assert.rejects(provider.stage(source, {
    signal: controller.signal,
    prepareRuntime: () => controller.abort(new DOMException("cancelled", "AbortError")),
  }), { name: "AbortError" });
  assert.equal((await provider.current())?.runtimeId, first.runtimeId);
});

test("reset supports the same unpublished runtime preparation boundary", async (t) => {
  const { provider, source } = await fixture(t);
  const first = await provider.stage(source);
  const reset = await provider.resetCurrent({
    prepareRuntime: async (candidate) => {
      await writeFile(path.join(candidate.runtimePath, "reset-prepared.txt"), "ready");
    },
  });
  assert.notEqual(reset.runtimeId, first.runtimeId);
  assert.equal(await readFile(path.join(reset.runtimePath, "reset-prepared.txt"), "utf8"), "ready");
});
