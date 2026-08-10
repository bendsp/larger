import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSandbox, inspectSandboxChanges, isSymlink } from "./sandbox.js";

test("copies dependencies without a write-through symlink and omits source symlinks", async (context) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "larger-sandbox-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source");
  const runtime = path.join(base, "runtime");
  const packageStore = path.join(source, "node_modules", ".store", "fixture");
  await Promise.all([
    mkdir(path.join(source, "src"), { recursive: true }),
    mkdir(packageStore, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(source, "src", "App.tsx"), "export const App = () => null"),
    writeFile(path.join(packageStore, "index.js"), "export {}"),
    writeFile(path.join(base, "outside.txt"), "private"),
  ]);
  await symlink(path.join(base, "outside.txt"), path.join(source, "src", "outside-link"));
  await symlink(path.join(".store", "fixture"), path.join(source, "node_modules", "fixture"));

  const baseline = await createSandbox(source, runtime, base);

  await assert.rejects(access(path.join(runtime, "src", "outside-link")));
  assert.equal(await isSymlink(path.join(runtime, "node_modules", "fixture")), true);
  const canonicalRuntime = await realpath(runtime);
  assert.ok((await realpath(path.join(runtime, "node_modules", "fixture"))).startsWith(canonicalRuntime));
  assert.deepEqual(await inspectSandboxChanges(baseline, runtime), []);
});

test("rejects a runtime nested inside the source project", async (context) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "larger-nested-"));
  context.after(() => rm(source, { recursive: true, force: true }));
  await assert.rejects(
    createSandbox(source, path.join(source, ".larger", "runtime"), path.dirname(source)),
    /must be separate|trusted runtime anchor/,
  );
});

test("rejects symlinks in the runtime path", async (context) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "larger-runtime-link-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source");
  const redirected = path.join(base, "redirected");
  await Promise.all([
    mkdir(path.join(source, "node_modules"), { recursive: true }),
    mkdir(redirected, { recursive: true }),
  ]);
  await symlink(redirected, path.join(base, "runtime-link"));
  await assert.rejects(
    createSandbox(source, path.join(base, "runtime-link", "project"), base),
    /contains a symlink/,
  );
});
