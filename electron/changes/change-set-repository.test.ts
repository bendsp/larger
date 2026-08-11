import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CHANGE_SET_FORMAT_VERSION,
  type ChangeFile,
  type ChangeSetSnapshot,
  type TextFileChange,
} from "../../src/change-contracts.js";
import { createWorkspacePaths } from "../runtime-workspaces/security.js";
import { BlobStore } from "./blob-store.js";
import { ChangeSetRepository, preserveStableSelection } from "./change-set-repository.js";
import { diffTextFiles } from "./diff-engine.js";
import { decodeTextFile } from "./text-codec.js";

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
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-change-repo-"));
  t.after(async () => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const workspacePaths = await createWorkspacePaths(path.join(root, "user-data"), "instance_change-repo");
  const blobs = await BlobStore.open(workspacePaths);
  return { root, blobs, repository: await ChangeSetRepository.open(workspacePaths, blobs) };
}

async function textChange(blobs: BlobStore): Promise<TextFileChange> {
  const baselineBytes = Buffer.from("one\ntwo\n");
  const editedBytes = Buffer.from("ONE\ntwo\n");
  const baselineIdentity = await blobs.put(baselineBytes);
  const editedIdentity = await blobs.put(editedBytes);
  const baseline = decodeTextFile(baselineBytes);
  const edited = decodeTextFile(editedBytes);
  assert.ok(baseline.ok && edited.ok);
  const diff = diffTextFiles("src/file.ts", baseline.value, edited.value);
  assert.ok(diff.ok);
  return {
    kind: "text",
    id: "a".repeat(64),
    path: "src/file.ts",
    operation: "modify",
    baseline: { ...baseline.value.metadata, ...baselineIdentity },
    edited: { ...edited.value.metadata, ...editedIdentity },
    hunks: diff.value.hunks,
    possibleRename: null,
  };
}

function snapshot(file: TextFileChange, overrides: Partial<ChangeSetSnapshot> = {}): ChangeSetSnapshot {
  return {
    formatVersion: CHANGE_SET_FORMAT_VERSION,
    id: "change-set-1",
    revision: 1,
    projectId: "project.example",
    instanceKey: "instance_change-repo",
    baselineIdentity: "b".repeat(64),
    origin: { kind: "runtime-workspace", runtimeId: "runtime-1" },
    status: "detected",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    files: [file],
    selection: { files: [] },
    application: null,
    recovery: null,
    ...overrides,
  };
}

test("publishes immutable revisions and reloads history", async (t) => {
  const { repository, blobs } = await fixture(t);
  const file = await textChange(blobs);
  const first = snapshot(file);
  await repository.create(first);
  assert.deepEqual(await repository.load(first.id), first);

  const hunkId = file.hunks[0]?.id;
  assert.ok(hunkId);
  const second = snapshot(file, {
    revision: 2,
    status: "reviewing",
    updatedAt: "2026-08-11T00:00:01.000Z",
    selection: { files: [{ fileId: file.id, includeFile: true, hunkIds: [hunkId] }] },
  });
  await repository.update(second, 1);
  assert.deepEqual(await repository.load(first.id), second);
  assert.deepEqual(await repository.load(first.id, 1), first);
});

test("rejects stale revisions, illegal transitions, and stale hunk selections", async (t) => {
  const { repository, blobs } = await fixture(t);
  const file = await textChange(blobs);
  const first = snapshot(file);
  await repository.create(first);
  await assert.rejects(repository.update(snapshot(file, { revision: 3 }), 1), /Stale/);
  await assert.rejects(
    repository.update(snapshot(file, { revision: 2, status: "applied" }), 1),
    /Invalid ChangeSet transition/,
  );
  await assert.rejects(
    repository.update(snapshot(file, {
      revision: 2,
      status: "reviewing",
      selection: { files: [{ fileId: file.id, includeFile: true, hunkIds: ["c".repeat(64)] }] },
    }), 1),
    /stale hunk/,
  );
});

test("preserves selection only for stable file and hunk IDs", async (t) => {
  const { blobs } = await fixture(t);
  const file = await textChange(blobs);
  const hunkId = file.hunks[0]?.id;
  assert.ok(hunkId);
  const previous = { files: [{ fileId: file.id, includeFile: true, hunkIds: [hunkId, "d".repeat(64)] }] };
  assert.deepEqual(preserveStableSelection(previous, [file]), {
    files: [{ fileId: file.id, includeFile: true, hunkIds: [hunkId] }],
  });
  const changedFile: ChangeFile = { ...file, id: "e".repeat(64) };
  assert.deepEqual(preserveStableSelection(previous, [changedFile]), { files: [] });
});

test("fails closed when a persisted revision is tampered", async (t) => {
  const { repository, blobs } = await fixture(t);
  const file = await textChange(blobs);
  const first = snapshot(file);
  await repository.create(first);
  const directory = path.join(repository.paths.changeSetsRoot, first.id);
  const pointer = JSON.parse(await readFile(path.join(directory, "current.json"), "utf8")) as {
    revision: number;
    snapshotSha256: string;
  };
  const revision = path.join(directory, "revisions", `${pointer.revision}-${pointer.snapshotSha256}.json`);
  await chmod(revision, 0o600);
  await writeFile(revision, "{}\n");
  await assert.rejects(repository.load(first.id), /invalid|Unsupported|identity/i);
});
test("active ChangeSet pointer survives a repository restart", async (t) => {
  const { root, blobs, repository } = await fixture(t);
  const created = await repository.create(snapshot(await textChange(blobs)));
  const updated = await repository.update(
    { ...created, revision: created.revision + 1 },
    created.revision,
  );

  const workspacePaths = await createWorkspacePaths(
    path.join(root, "user-data"),
    "instance_change-repo",
  );
  const reopened = await ChangeSetRepository.open(workspacePaths, blobs);
  assert.deepEqual(await reopened.loadCurrent(), updated);
});

test("loadCurrent returns null only when the active pointer is absent", async (t) => {
  const { repository } = await fixture(t);
  assert.equal(await repository.loadCurrent(), null);
});

test("loadCurrent rejects a future active-pointer version", async (t) => {
  const { blobs, repository } = await fixture(t);
  await repository.create(snapshot(await textChange(blobs)));
  const pointerPath = (
    repository as unknown as { readonly activePointerPath: string }
  ).activePointerPath;
  const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as Record<string, unknown>;
  pointer.formatVersion = 2;
  await writeFile(pointerPath, `${JSON.stringify(pointer)}\n`, "utf8");

  await assert.rejects(repository.loadCurrent(), /Unsupported active ChangeSet pointer version/);
});

test("loadCurrent rejects a tampered active-pointer digest", async (t) => {
  const { blobs, repository } = await fixture(t);
  await repository.create(snapshot(await textChange(blobs)));
  const pointerPath = (
    repository as unknown as { readonly activePointerPath: string }
  ).activePointerPath;
  const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as Record<string, unknown>;
  pointer.snapshotSha256 = "f".repeat(64);
  await writeFile(pointerPath, `${JSON.stringify(pointer)}\n`, "utf8");

  await assert.rejects(repository.loadCurrent(), /digest does not match/);
});

test("loadCurrent fails closed when its immutable revision is missing", async (t) => {
  const { blobs, repository } = await fixture(t);
  await repository.create(snapshot(await textChange(blobs)));
  const pointerPath = (
    repository as unknown as { readonly activePointerPath: string }
  ).activePointerPath;
  const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as Record<string, unknown>;
  pointer.revision = 999;
  await writeFile(pointerPath, `${JSON.stringify(pointer)}\n`, "utf8");

  await assert.rejects(repository.loadCurrent(), /missing|ENOENT/i);
});
import { symlink as createSymlink, unlink as unlinkPath } from "node:fs/promises";

test("loadCurrent rejects a symlinked active pointer", async (t) => {
  if (process.platform === "win32") {
    t.skip("Creating symlinks requires additional privileges on Windows.");
    return;
  }

  const { root, blobs, repository } = await fixture(t);
  await repository.create(snapshot(await textChange(blobs)));
  const pointerPath = (
    repository as unknown as { readonly activePointerPath: string }
  ).activePointerPath;
  const externalPointerPath = path.join(root, "redirected-change-set-pointer.json");
  await writeFile(externalPointerPath, await readFile(pointerPath));
  await unlinkPath(pointerPath);
  await createSymlink(externalPointerPath, pointerPath);

  await assert.rejects(repository.loadCurrent(), /ELOOP|symbolic link/i);
});
