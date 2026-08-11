import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspacePaths } from "../runtime-workspaces/security.js";
import { DesktopRecoveryCoordinator } from "./recovery-coordinator.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

test("desktop recovery removes only recognized abandoned staging", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-desktop-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, "user-data");
  const workspace = await createWorkspacePaths(userDataPath, "instance_recovery");
  const abandonedWorkspace = path.join(workspace.stagingRoot, A);
  const unknownWorkspace = path.join(workspace.stagingRoot, "future-format");
  await mkdir(abandonedWorkspace);
  await mkdir(unknownWorkspace);

  const changeStaging = path.join(workspace.instanceRoot, "changes", "staging");
  await mkdir(changeStaging, { recursive: true });
  const abandonedBlob = path.join(changeStaging, `blob-${A}.tmp`);
  const unknownBlob = path.join(changeStaging, "do-not-delete.tmp");
  await writeFile(abandonedBlob, "partial");
  await writeFile(unknownBlob, "future");

  const dependencyStaging = path.join(workspace.instanceRoot, "dependencies", "staging");
  await mkdir(dependencyStaging, { recursive: true });
  const abandonedDependency = path.join(dependencyStaging, `operation-41-${A}`);
  const liveDependency = path.join(dependencyStaging, `operation-42-${B}`);
  await mkdir(abandonedDependency);
  await mkdir(liveDependency);

  const outside = path.join(root, "outside");
  await mkdir(outside);
  const linkedWorkspace = path.join(workspace.stagingRoot, `reset-${B}`);
  await symlink(outside, linkedWorkspace);

  const order: string[] = [];
  const report = await new DesktopRecoveryCoordinator({
    userDataPath,
    isProcessAlive: (pid) => pid === 42,
    participants: [
      { id: "runtime", async recover() { order.push("runtime"); } },
      { id: "changes", async recover() { order.push("changes"); throw new Error("manual recovery required"); } },
    ],
  }).recover();

  assert.deepEqual(order, ["runtime", "changes"]);
  assert.equal(report.status, "incomplete");
  await assert.rejects(access(abandonedWorkspace), /ENOENT/);
  await assert.rejects(access(abandonedBlob), /ENOENT/);
  await assert.rejects(access(abandonedDependency), /ENOENT/);
  await writeFile(path.join(unknownWorkspace, "retained"), "yes");
  assert.equal(await readFile(unknownBlob, "utf8"), "future");
  await writeFile(path.join(liveDependency, "retained"), "yes");
  await writeFile(path.join(outside, "retained"), "yes");
  assert.ok(report.entries.some((entry) => entry.kind === "staging" && entry.path === linkedWorkspace && entry.status === "preserved"));
});

test("desktop recovery rejects duplicate participant identifiers", () => {
  assert.throws(() => new DesktopRecoveryCoordinator({
    userDataPath: "/unused",
    participants: [
      { id: "runtime", async recover() {} },
      { id: "runtime", async recover() {} },
    ],
  }), /unique/);
});

test("preserved staging alone makes desktop recovery incomplete", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-desktop-recovery-preserved-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, "user-data");
  const workspace = await createWorkspacePaths(userDataPath, "instance_preserved");
  const unknownWorkspace = path.join(workspace.stagingRoot, "future-format");
  await mkdir(unknownWorkspace);

  const report = await new DesktopRecoveryCoordinator({ userDataPath }).recover();

  assert.equal(report.status, "incomplete");
  assert.deepEqual(report.entries, [{
    kind: "staging",
    path: unknownWorkspace,
    status: "preserved",
    reason: "unrecognized-name",
  }]);
  await writeFile(path.join(unknownWorkspace, "still-here"), "preserved");
});
