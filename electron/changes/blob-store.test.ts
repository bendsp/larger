import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspacePaths } from "../runtime-workspaces/security.js";
import { BlobStore } from "./blob-store.js";

async function makeWritable(root: string): Promise<void> {
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
  for (const child of await readdir(root)) await makeWritable(path.join(root, child));
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-blobs-"));
  t.after(async () => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source");
  await mkdir(source);
  const workspacePaths = await createWorkspacePaths(path.join(root, "user-data"), "instance_blob-test");
  return { root, source, store: await BlobStore.open(workspacePaths) };
}

test("stores immutable content by identity and enforces bounded reads", async (t) => {
  const { store } = await fixture(t);
  const bytes = Buffer.from("durable bytes\n");
  const identity = await store.put(bytes);
  assert.deepEqual(Buffer.from(await store.read(identity, { maxBytes: bytes.length })), bytes);
  await assert.rejects(store.read(identity, { maxBytes: bytes.length - 1 }), /exceeds read limit/);
  await store.verify(identity);
});

test("captures regular files without following a final symlink", async (t) => {
  const { source, store } = await fixture(t);
  const file = path.join(source, "file.txt");
  await writeFile(file, "captured", { mode: 0o755 });
  const captured = await store.captureFile(file, source);
  assert.equal(captured.mode & 0o111, 0o111);
  assert.equal(Buffer.from(await store.read(captured.identity, { maxBytes: 1024 })).toString(), "captured");

  const link = path.join(source, "link.txt");
  await symlink("file.txt", link);
  await assert.rejects(store.captureFile(link, source), /symbolic link|ELOOP/);
});

test("large blobs verify by streaming, bounded reads fail before allocation, and cancellation is honored", async (t) => {
  const { store } = await fixture(t);
  const bytes = Buffer.alloc(20 * 1024 * 1024, 0x61);
  const identity = await store.put(bytes);
  await store.verify(identity);
  await assert.rejects(store.read(identity, { maxBytes: 16 * 1024 * 1024 }), /exceeds read limit/);

  const controller = new AbortController();
  controller.abort(new Error("cancel verification"));
  await assert.rejects(store.verify(identity, controller.signal), /cancel verification/);
});

test("detects durable blob tampering", async (t) => {
  const { store } = await fixture(t);
  const identity = await store.put(Buffer.from("trusted"));
  const shard = path.join(store.paths.blobsRoot, identity.sha256.slice(0, 2));
  const blob = path.join(shard, identity.sha256);
  await chmod(blob, 0o600);
  await writeFile(blob, "tampered");
  await assert.rejects(store.verify(identity), /integrity|invalid/);
  assert.equal(await readFile(blob, "utf8"), "tampered");
});
