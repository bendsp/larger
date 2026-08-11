import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizeSourceRoot, readSourceLeaf } from "./source-authorization.js";
import { assessTransactionRecovery } from "./recovery.js";
import {
  SourceTransactionRepository,
  transactionBlobReference,
  transactionPlanDigest,
  type SourceTransactionJournal,
} from "./transaction-journal.js";

test("journal persists verified blobs before fail-closed metadata", async () => {
  const instanceRoot = await mkdtemp(path.join(os.tmpdir(), "larger-transactions-"));
  const repository = await SourceTransactionRepository.create(instanceRoot, "instance-a");
  const transactionId = repository.newTransactionId();
  const replacement = Buffer.from("after\n");
  const replacementRef = transactionBlobReference(replacement);
  const now = new Date().toISOString();
  const absent = { kind: "absent" as const, sha256: null, size: 0, mode: null, device: null, inode: null };
  const journal: SourceTransactionJournal = {
    formatVersion: 1,
    transactionId,
    changeSetId: "changes-a",
    changeSetRevision: 1,
    projectId: "project-a",
    instanceKey: "instance-a",
    projectGeneration: 1,
    canonicalSourceRoot: "/source",
    sourceRootDevice: 1,
    sourceRootInode: 1,
    baselineIdentity: "baseline-a",
    runtimeId: "runtime-a",
    get planDigest(): string {
      return transactionPlanDigest({
        changeSetId: "changes-a",
        changeSetRevision: 1,
        projectId: "project-a",
        instanceKey: "instance-a",
        baselineIdentity: "baseline-a",
        runtimeId: "runtime-a",
        files: this.files.map(({ path, operation, expected, result, mode, temporaryName }) => ({
          path,
          operation,
          expected,
          result,
          mode,
          temporaryName,
        })),
      });
    },
    createdAt: now,
    updatedAt: now,
    state: "prepared",
    files: [{
      path: "new.txt",
      operation: "replace",
      expected: absent,
      result: { ...absent, kind: "file", sha256: replacementRef.sha256, size: replacement.length, mode: 0o644 },
      backup: null,
      replacement: replacementRef,
      mode: 0o644,
      temporaryName: `.larger-${transactionId}-${"a".repeat(16)}.tmp`,
      state: "pending",
      plannedDirectories: [],
      createdDirectories: [],
    }],
  };
  await repository.createJournal(journal, new Map([[replacementRef.sha256, replacement]]));
  assert.deepEqual(await repository.read(transactionId), journal);
  assert.deepEqual(await repository.readBlob(transactionId, replacementRef), replacement);
});

test("recovery classifies expected, result, and unknown source truth", async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "larger-recovery-"));
  await mkdir(path.join(sourceRoot, "src"));
  await writeFile(path.join(sourceRoot, "src/view.tsx"), "before\n");
  const root = await authorizeSourceRoot(sourceRoot);
  const before = await readSourceLeaf(root, "src/view.tsx");
  const afterBytes = Buffer.from("after\n");
  const afterRef = transactionBlobReference(afterBytes);
  const journal = {
    formatVersion: 1 as const,
    transactionId: "00000000-0000-4000-8000-000000000000",
    changeSetId: "change",
    changeSetRevision: 1,
    projectId: "project",
    instanceKey: "instance",
    projectGeneration: 1,
    canonicalSourceRoot: root.canonicalRoot,
    sourceRootDevice: root.device,
    sourceRootInode: root.inode,
    baselineIdentity: "baseline",
    runtimeId: "runtime",
    planDigest: transactionPlanDigest("plan"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: "prepared" as const,
    files: [{
      path: "src/view.tsx",
      operation: "replace" as const,
      expected: before,
      result: { ...before, sha256: afterRef.sha256, size: afterBytes.length },
      backup: transactionBlobReference(Buffer.from("before\n")),
      replacement: afterRef,
      mode: before.mode,
      temporaryName: ".larger-00000000-0000-4000-8000-000000000000-bbbbbbbbbbbbbbbb.tmp",
      state: "pending" as const,
      plannedDirectories: [],
      createdDirectories: [],
    }],
  };
  assert.equal((await assessTransactionRecovery(journal, root)).files[0]?.state, "expected");
  await chmod(path.join(sourceRoot, "src/view.tsx"), 0o755);
  const modeDrift = await assessTransactionRecovery(journal, root);
  assert.equal(modeDrift.files[0]?.state, "unknown");
  assert.equal(modeDrift.safeToRollBack, false);
  await chmod(path.join(sourceRoot, "src/view.tsx"), before.mode ?? 0o644);
  await writeFile(path.join(sourceRoot, "src/view.tsx"), afterBytes);
  assert.equal((await assessTransactionRecovery(journal, root)).files[0]?.state, "result");
  await writeFile(path.join(sourceRoot, "src/view.tsx"), "third\n");
  const assessment = await assessTransactionRecovery(journal, root);
  assert.equal(assessment.files[0]?.state, "unknown");
  assert.equal(assessment.safeToRollForward, false);
});
