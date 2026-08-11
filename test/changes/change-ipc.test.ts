import assert from "node:assert/strict";
import test from "node:test";
import {
  changeOperationResultSchema,
  changeWorkspaceSnapshotSchema,
  preparedApplyResultSchema,
} from "../../src/change-ipc.js";

const sha = "a".repeat(64);
const timestamp = "2026-08-11T10:00:00.000Z";
const changeSet = {
  formatVersion: 1,
  id: "changes-a",
  revision: 1,
  projectId: "project-a",
  instanceKey: "instance-a",
  baselineIdentity: sha,
  origin: { kind: "runtime-workspace", runtimeId: "00000000-0000-4000-8000-000000000000" },
  status: "reviewing",
  createdAt: timestamp,
  updatedAt: timestamp,
  files: [],
  selection: { files: [] },
  application: null,
  recovery: null,
} as const;
const snapshot = {
  revision: 1,
  projectGeneration: 3,
  projectInstanceKey: "instance-a",
  operation: null,
  changeSet,
  problem: null,
} as const;

test("change IPC accepts the versioned strict workspace envelope", () => {
  assert.deepEqual(changeWorkspaceSnapshotSchema.parse(snapshot), snapshot);
  assert.deepEqual(changeOperationResultSchema.parse({ status: "completed", snapshot }), { status: "completed", snapshot });
  assert.deepEqual(preparedApplyResultSchema.parse({
    status: "prepared",
    transactionId: "00000000-0000-4000-8000-000000000001",
    planDigest: sha,
    selectedFileCount: 1,
    selectedHunkCount: 2,
    conflictPaths: [],
    snapshot,
  }).status, "prepared");
});

test("change IPC rejects malformed and forward-unknown renderer data", () => {
  assert.equal(changeWorkspaceSnapshotSchema.safeParse({ ...snapshot, leakedPath: "/tmp/source" }).success, false);
  assert.equal(changeWorkspaceSnapshotSchema.safeParse({ ...snapshot, changeSet: { ...changeSet, status: "partially-applied" } }).success, false);
  assert.equal(changeWorkspaceSnapshotSchema.safeParse({ ...snapshot, revision: -1 }).success, false);
});
