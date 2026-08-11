import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CHANGE_SET_FORMAT_VERSION, type ChangeSetSnapshot } from "../../src/change-contracts.js";
import { PortableCopyMaterializer } from "../runtime-workspaces/materializers.js";
import { RuntimeWorkspaceProvider } from "../runtime-workspaces/provider.js";
import { createWorkspacePaths } from "../runtime-workspaces/security.js";
import { BlobStore } from "./blob-store.js";
import { ChangeSetRepository } from "./change-set-repository.js";
import { RuntimeChangeScanner } from "./runtime-change-scanner.js";

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
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-change-scan-"));
  t.after(async () => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source");
  const userData = path.join(root, "user-data");
  await mkdir(source);
  await mkdir(path.join(source, "src"));
  await writeFile(path.join(source, "src", "modify.txt"), "one\ntwo\nthree\nfour\n");
  await writeFile(path.join(source, "src", "delete.txt"), "delete me\n");
  await writeFile(path.join(source, "src", "old-name.txt"), "rename bytes\n");
  await writeFile(path.join(source, "src", "mode.txt"), "mode\n", { mode: 0o644 });
  const provider = new RuntimeWorkspaceProvider({
    userDataPath: userData,
    localInstanceKey: "instance_change-scan",
    materializer: new PortableCopyMaterializer(),
  });
  const workspace = await provider.stage(source);
  const workspacePaths = await createWorkspacePaths(userData, "instance_change-scan");
  const blobs = await BlobStore.open(workspacePaths);
  return {
    root,
    source,
    workspace,
    blobs,
    scanner: await RuntimeChangeScanner.open(workspacePaths, blobs),
    repository: await ChangeSetRepository.open(workspacePaths, blobs),
  };
}

test("derives text and unsupported filesystem changes with stable IDs", async (t) => {
  const { workspace, scanner } = await fixture(t);
  const runtimeSrc = path.join(workspace.runtimePath, "src");
  await writeFile(path.join(runtimeSrc, "modify.txt"), "ONE\ntwo\nthree\nFOUR\n");
  await rm(path.join(runtimeSrc, "delete.txt"));
  await rm(path.join(runtimeSrc, "old-name.txt"));
  await writeFile(path.join(runtimeSrc, "new-name.txt"), "rename bytes\n");
  await writeFile(path.join(runtimeSrc, "empty.txt"), "");
  await writeFile(path.join(runtimeSrc, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await chmod(path.join(runtimeSrc, "mode.txt"), 0o755);
  await symlink("modify.txt", path.join(runtimeSrc, "link.txt"));
  await mkdir(path.join(workspace.runtimePath, "node_modules"));
  await writeFile(path.join(workspace.runtimePath, "node_modules", "ignored.js"), "ignored");

  const first = await scanner.scan(workspace);
  const second = await scanner.scan(workspace);
  assert.deepEqual(first, second);
  assert.equal(first.files.some((file) => file.path.includes("node_modules")), false);

  const modified = first.files.find((file) => file.path === "src/modify.txt");
  assert.equal(modified?.kind, "text");
  assert.equal(modified?.operation, "modify");
  assert.equal(modified?.kind === "text" ? modified.hunks.some((hunk) => hunk.kind === "text") : false, true);
  assert.equal(first.files.find((file) => file.path === "src/delete.txt")?.operation, "delete");
  const empty = first.files.find((file) => file.path === "src/empty.txt");
  const binary = first.files.find((file) => file.path === "src/binary.bin");
  const mode = first.files.find((file) => file.path === "src/mode.txt");
  const link = first.files.find((file) => file.path === "src/link.txt");
  assert.equal(empty?.kind, "text");
  assert.deepEqual(empty?.kind === "text" ? empty.hunks : undefined, []);
  assert.equal(binary?.kind, "unsupported");
  assert.equal(binary?.kind === "unsupported" ? binary.reason : null, "binary");
  assert.equal(mode?.kind === "unsupported" ? mode.reason : null, "mode-change");
  assert.equal(link?.kind === "unsupported" ? link.reason : null, "symlink");

  const deleted = first.files.find((file) => file.path === "src/old-name.txt");
  const added = first.files.find((file) => file.path === "src/new-name.txt");
  assert.equal(deleted?.possibleRename?.otherPath, "src/new-name.txt");
  assert.equal(added?.possibleRename?.otherPath, "src/old-name.txt");
});

test("persisted ChangeSets and raw blobs survive deletion of the runtime", async (t) => {
  const { workspace, scanner, repository, blobs } = await fixture(t);
  await writeFile(path.join(workspace.runtimePath, "src", "modify.txt"), "edited forever\n");
  const scan = await scanner.scan(workspace);
  const changeSet: ChangeSetSnapshot = {
    formatVersion: CHANGE_SET_FORMAT_VERSION,
    id: "durable-detection",
    revision: 1,
    projectId: "project.example",
    instanceKey: "instance_change-scan",
    baselineIdentity: scan.baselineIdentity,
    origin: { kind: "runtime-workspace", runtimeId: scan.runtimeId },
    status: "detected",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    files: scan.files,
    selection: { files: [] },
    application: null,
    recovery: null,
  };
  await repository.create(changeSet);
  const changed = scan.files.find((file) => file.path === "src/modify.txt");
  assert.ok(changed?.edited);
  await rm(workspace.runtimePath, { recursive: true });

  assert.deepEqual(await repository.load(changeSet.id), changeSet);
  assert.equal(
    Buffer.from(await blobs.read(changed.edited, { maxBytes: 1024 })).toString(),
    "edited forever\n",
  );
  assert.equal(await readFile(path.join(workspace.baselinePath, "tree", "src", "modify.txt"), "utf8"), "one\ntwo\nthree\nfour\n");
});

test("does not emit ambiguous rename hints for duplicate exact content", async (t) => {
  const { workspace, scanner } = await fixture(t);
  const runtimeSrc = path.join(workspace.runtimePath, "src");
  await rm(path.join(runtimeSrc, "old-name.txt"));
  await writeFile(path.join(runtimeSrc, "new-a.txt"), "rename bytes\n");
  await writeFile(path.join(runtimeSrc, "new-b.txt"), "rename bytes\n");
  const scan = await scanner.scan(workspace);
  for (const file of scan.files.filter((candidate) => /old-name|new-[ab]/.test(candidate.path))) {
    assert.equal(file.possibleRename, null);
  }
});

test("rejects a workspace handle whose paths do not belong to the local instance", async (t) => {
  const { workspace, scanner, root } = await fixture(t);
  const outside = path.join(root, "outside-runtime");
  await mkdir(outside);
  await assert.rejects(scanner.scan({ ...workspace, runtimePath: outside }), /do not belong|escapes/);
});
