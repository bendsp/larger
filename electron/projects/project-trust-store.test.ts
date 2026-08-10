import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectIdentity } from "./project-identity.js";
import { ProjectTrustStore } from "./project-trust-store.js";

test("binds trust to logical identity, instance key, and canonical path", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-trust-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const firstPath = path.join(root, "first");
  const clonePath = path.join(root, "clone");
  await mkdir(firstPath);
  await mkdir(clonePath);
  const first = await createProjectIdentity("example.project", firstPath);
  const clone = await createProjectIdentity("example.project", clonePath);
  const store = new ProjectTrustStore(path.join(root, "trust.json"));
  await store.setDecision(first, "trusted", new Date("2026-01-01T00:00:00Z"));
  assert.equal(await store.decisionFor(first), "trusted");
  assert.equal(await store.decisionFor(clone), null);
});

test("updates a decision without rewriting its creation time", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-trust-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, "project");
  await mkdir(projectPath);
  const identity = await createProjectIdentity("example.project", projectPath);
  const store = new ProjectTrustStore(path.join(root, "trust.json"));
  await store.setDecision(identity, "trusted", new Date("2026-01-01T00:00:00Z"));
  const updated = await store.setDecision(identity, "denied", new Date("2026-01-02T00:00:00Z"));
  assert.equal(updated.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(updated.updatedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(await store.decisionFor(identity), "denied");
  assert.equal(await store.revoke(identity), true);
  assert.equal(await store.decisionFor(identity), null);
  assert.equal(await store.revoke(identity), false);
});

test("rejects forged identity bindings", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-trust-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, "project");
  await mkdir(projectPath);
  const identity = await createProjectIdentity("example.project", projectPath);
  const store = new ProjectTrustStore(path.join(root, "trust.json"));
  await assert.rejects(store.setDecision({ ...identity, canonicalPath: root }, "trusted"), /does not match/);
});
