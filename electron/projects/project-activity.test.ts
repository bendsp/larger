import assert from "node:assert/strict";
import test from "node:test";
import { ProjectActivityConflictError, ProjectActivityCoordinator } from "./project-activity.js";

test("source activity serializes writers and blocks switching until release", async () => {
  const activity = new ProjectActivityCoordinator();
  const lease = activity.acquireSourceWrite("transaction-a");
  assert.equal(activity.hasActiveSession(), true);
  assert.throws(() => activity.acquireSourceWrite("transaction-b"), ProjectActivityConflictError);
  await assert.rejects(activity.stopForProjectSwitch(), ProjectActivityConflictError);
  lease.release();
  assert.equal(activity.hasActiveSession(), false);
  await activity.stopForProjectSwitch();
});

test("project switching awaits composite runtime cleanup", async () => {
  const activity = new ProjectActivityCoordinator();
  let active = true;
  let stops = 0;
  const unregister = activity.registerRuntimeParticipant({
    hasActiveRuntime: () => active,
    stopForProjectSwitch: async () => {
      stops += 1;
      await Promise.resolve();
      active = false;
    },
  });

  assert.equal(activity.hasActiveSession(), true);
  await activity.stopForProjectSwitch();
  assert.equal(stops, 1);
  assert.equal(activity.hasActiveSession(), false);
  unregister();
  await activity.stopForProjectSwitch();
  assert.equal(stops, 1);
});

test("source transaction blocks runtime cleanup until it is released", async () => {
  const activity = new ProjectActivityCoordinator();
  let stopped = false;
  activity.registerRuntimeParticipant({
    hasActiveRuntime: () => true,
    stopForProjectSwitch: async () => { stopped = true; },
  });
  const lease = activity.acquireSourceWrite("transaction-a");
  await assert.rejects(activity.stopForProjectSwitch(), ProjectActivityConflictError);
  assert.equal(stopped, false);
  lease.release();
  await activity.stopForProjectSwitch();
  assert.equal(stopped, true);
});
