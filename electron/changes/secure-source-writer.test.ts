import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizeSourceRoot, readSourceLeaf } from "./source-authorization.js";
import { SourceCompareAndSwapError, writeSourceFileSecurely } from "./secure-source-writer.js";

async function fixture(): Promise<{ root: string; authorized: Awaited<ReturnType<typeof authorizeSourceRoot>> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-source-writer-"));
  return { root, authorized: await authorizeSourceRoot(root) };
}

test("atomically replaces a matching regular file", async () => {
  const { root, authorized } = await fixture();
  await writeFile(path.join(root, "view.tsx"), "before\n");
  const expected = await readSourceLeaf(authorized, "view.tsx");
  const phases: string[] = [];
  const result = await writeSourceFileSecurely({
    root: authorized,
    relativePath: "view.tsx",
    expected,
    operation: { kind: "replace", bytes: Buffer.from("after\n") },
    onIntentDurable: async () => { phases.push("intent"); },
    onSourceDurable: async () => { phases.push("source"); },
  });
  assert.equal(await readFile(path.join(root, "view.tsx"), "utf8"), "after\n");
  assert.deepEqual(phases, ["intent", "source"]);
  assert.equal(result.after.kind, "file");
});

test("rejects drift immediately before replacement", async () => {
  const { root, authorized } = await fixture();
  await writeFile(path.join(root, "view.tsx"), "before\n");
  const expected = await readSourceLeaf(authorized, "view.tsx");
  await assert.rejects(writeSourceFileSecurely({
    root: authorized,
    relativePath: "view.tsx",
    expected,
    operation: { kind: "replace", bytes: Buffer.from("after\n") },
    onIntentDurable: async () => { await writeFile(path.join(root, "view.tsx"), "concurrent\n"); },
    onSourceDurable: async () => undefined,
  }), SourceCompareAndSwapError);
  assert.equal(await readFile(path.join(root, "view.tsx"), "utf8"), "concurrent\n");
});

test("rejects a concurrent mode change even when source bytes are unchanged", async () => {
  const { root, authorized } = await fixture();
  const source = path.join(root, "view.tsx");
  await writeFile(source, "before\n", { mode: 0o644 });
  const expected = await readSourceLeaf(authorized, "view.tsx");
  await chmod(source, 0o755);
  await assert.rejects(writeSourceFileSecurely({
    root: authorized,
    relativePath: "view.tsx",
    expected,
    operation: { kind: "replace", bytes: Buffer.from("after\n") },
    onIntentDurable: async () => undefined,
    onSourceDurable: async () => undefined,
  }), SourceCompareAndSwapError);
  assert.equal(await readFile(source, "utf8"), "before\n");
  assert.equal((await readSourceLeaf(authorized, "view.tsx")).mode, 0o755);
});

test("rejects symlink parents and leaves the outside file untouched", async () => {
  const { root, authorized } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "larger-source-outside-"));
  await writeFile(path.join(outside, "view.tsx"), "outside\n");
  await symlink(outside, path.join(root, "linked"));
  const absent = { kind: "absent" as const, sha256: null, size: 0, mode: null, device: null, inode: null };
  await assert.rejects(writeSourceFileSecurely({
    root: authorized,
    relativePath: "linked/view.tsx",
    expected: absent,
    operation: { kind: "replace", bytes: Buffer.from("escaped\n") },
    onIntentDurable: async () => undefined,
    onSourceDurable: async () => undefined,
  }));
  assert.equal(await readFile(path.join(outside, "view.tsx"), "utf8"), "outside\n");
});

test("creates real parent directories for an authorized addition", async () => {
  const { root, authorized } = await fixture();
  await mkdir(path.join(root, "src"));
  const expected = await readSourceLeaf(authorized, "src/new/deep/view.tsx");
  const result = await writeSourceFileSecurely({
    root: authorized,
    relativePath: "src/new/deep/view.tsx",
    expected,
    operation: { kind: "replace", bytes: Buffer.from("created\n") },
    onIntentDurable: async () => undefined,
    onSourceDurable: async () => undefined,
  });
  assert.deepEqual(result.createdDirectories, ["src/new", "src/new/deep"]);
  assert.equal(await readFile(path.join(root, "src/new/deep/view.tsx"), "utf8"), "created\n");
});
