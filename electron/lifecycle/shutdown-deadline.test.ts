import assert from "node:assert/strict";
import test from "node:test";

import {
  runWithShutdownDeadline,
  SHUTDOWN_DEADLINE_MS,
  shutdownExitAction,
  ShutdownDeadlineError,
} from "./shutdown-deadline.js";

test("shutdown deadline allows completed cleanup", async () => {
  let completed = false;
  await runWithShutdownDeadline(async () => { completed = true; }, 50);
  assert.equal(completed, true);
});

test("shutdown deadline rejects a hung cleanup", async () => {
  await assert.rejects(
    runWithShutdownDeadline(() => new Promise(() => undefined), 5),
    ShutdownDeadlineError,
  );
});

test("desktop shutdown reserves forced exit for deadline exhaustion", () => {
  assert.equal(SHUTDOWN_DEADLINE_MS, 15_000);
  assert.equal(shutdownExitAction(new ShutdownDeadlineError("late")), "exit");
  assert.equal(shutdownExitAction(new Error("cleanup failed")), "quit");
});
