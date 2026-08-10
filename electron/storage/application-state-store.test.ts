import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectIdentity } from "../../src/project-contracts.js";
import { ApplicationStateStore } from "./application-state-store.js";

function identity(index: number): ProjectIdentity {
  const canonicalPath = path.join(os.tmpdir(), `project-${index}`);
  return { projectId: `project.${index}`, instanceKey: `instance_${index}`, canonicalPath };
}

test("stores recents in most-recent order and deduplicates project instances", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-app-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new ApplicationStateStore(path.join(root, "state.json"));
  await store.recordRecent(identity(1), "First", new Date("2026-01-01T00:00:00Z"));
  await store.recordRecent(identity(2), "Second", new Date("2026-01-02T00:00:00Z"));
  const state = await store.recordRecent(identity(1), "Renamed", new Date("2026-01-03T00:00:00Z"));
  assert.deepEqual(state.recentProjects.map(({ displayName }) => displayName), ["Renamed", "Second"]);
  assert.equal(state.recentProjects[0]?.lastOpenedAt, "2026-01-03T00:00:00.000Z");
});

test("bounds recents and keeps personal state outside the project", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-app-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new ApplicationStateStore(path.join(root, "state.json"));
  for (let index = 0; index < 25; index += 1) {
    await store.recordRecent(identity(index), `Project ${index}`, new Date(1_700_000_000_000 + index));
  }
  const state = await store.setPersonalState("instance_24", {
    selectedRuntimeProfile: "dev",
    lastRoute: "/about",
    selectedSection: "assets",
  });
  assert.equal(state.recentProjects.length, 20);
  assert.deepEqual(state.personalStateByInstance.instance_24, {
    selectedRuntimeProfile: "dev",
    lastRoute: "/about",
    selectedSection: "assets",
  });
  await assert.rejects(
    store.setPersonalState("instance_24", { lastRoute: "not-a-route" }),
    /application-relative route/,
  );
  await assert.rejects(
    store.setPersonalState("instance_24", { lastRoute: "//evil.example" }),
    /application-relative route/,
  );
  await assert.rejects(
    store.setPersonalState("instance_24", { selectedSection: "unknown" as "assets" }),
    /known project section/,
  );
});

test("removes a recent without deleting its personal state", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-app-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new ApplicationStateStore(path.join(root, "state.json"));
  await store.recordRecent(identity(1), "First");
  await store.setPersonalState("instance_1", { lastRoute: "/" });
  const state = await store.removeRecent("instance_1");
  assert.equal(state.recentProjects.length, 0);
  assert.deepEqual(state.personalStateByInstance.instance_1, { lastRoute: "/" });
});
