import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectIdentity, projectInstanceKey, sameProjectInstance } from "./project-identity.js";

test("creates a stable instance key from logical identity and canonical path", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "larger-identity-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const project = path.join(temporaryRoot, "project");
  const alias = path.join(temporaryRoot, "alias");
  await mkdir(project);
  await symlink(project, alias);

  const direct = await createProjectIdentity("example.project", project);
  const throughAlias = await createProjectIdentity("example.project", alias);
  assert.deepEqual(direct, throughAlias);
  assert.match(direct.instanceKey, /^instance_[a-f0-9]{64}$/);
  assert.ok(sameProjectInstance(direct, throughAlias));
});

test("separates clones and logical projects", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "larger-identity-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const first = path.join(temporaryRoot, "first");
  const second = path.join(temporaryRoot, "second");
  await mkdir(first);
  await mkdir(second);
  const firstIdentity = await createProjectIdentity("example.project", first);
  const clonedIdentity = await createProjectIdentity("example.project", second);
  const otherIdentity = await createProjectIdentity("other.project", first);
  assert.notEqual(firstIdentity.instanceKey, clonedIdentity.instanceKey);
  assert.notEqual(firstIdentity.instanceKey, otherIdentity.instanceKey);
});

test("rejects invalid logical IDs and non-absolute canonical paths", () => {
  assert.throws(() => projectInstanceKey("bad id", "/project"), /logical project ID/);
  assert.throws(() => projectInstanceKey("valid.id", "relative/project"), /absolute/);
});
