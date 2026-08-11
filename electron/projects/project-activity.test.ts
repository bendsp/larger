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
