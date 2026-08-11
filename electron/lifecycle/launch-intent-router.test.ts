import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  LaunchIntentRouter,
  OPEN_PROJECT_ARGUMENT,
  launchIntentFromPath,
  parseLaunchIntent,
} from "./launch-intent-router.js";

test("launch arguments accept only the explicit absolute project-path option", () => {
  const projectPath = path.resolve("fixtures/project");
  assert.deepEqual(
    parseLaunchIntent(["Larger", OPEN_PROJECT_ARGUMENT, projectPath], "initial"),
    { kind: "open-project", path: projectPath, source: "initial" },
  );
  assert.deepEqual(
    parseLaunchIntent([`--inspect=9229`, `${OPEN_PROJECT_ARGUMENT}=${projectPath}`], "second-instance"),
    { kind: "open-project", path: projectPath, source: "second-instance" },
  );
  assert.equal(parseLaunchIntent(["Larger", projectPath], "initial"), null);
  assert.equal(parseLaunchIntent([OPEN_PROJECT_ARGUMENT, "relative/project"], "initial"), null);
  assert.equal(launchIntentFromPath("relative/project", "open-file"), null);
});

test("pre-ready launch requests coalesce to the newest project", async () => {
  const router = new LaunchIntentRouter();
  const opened: string[] = [];
  router.submit(launchIntentFromPath(path.resolve("first"), "open-file"));
  router.submit(launchIntentFromPath(path.resolve("second"), "second-instance"));

  router.attach((intent) => {
    opened.push(intent.path);
  });
  await router.idle();

  assert.deepEqual(opened, [path.resolve("second")]);
});

test("ready launch requests are serialized and stop rejects later work", async () => {
  const router = new LaunchIntentRouter();
  const opened: string[] = [];
  router.attach(async (intent) => {
    await Promise.resolve();
    opened.push(intent.path);
  });
  router.submit(launchIntentFromPath(path.resolve("first"), "initial"));
  router.submit(launchIntentFromPath(path.resolve("second"), "second-instance"));
  await router.stop();
  router.submit(launchIntentFromPath(path.resolve("third"), "open-file"));

  assert.deepEqual(opened, []);
  assert.throws(() => router.attach(() => undefined), /stopped/);
});
