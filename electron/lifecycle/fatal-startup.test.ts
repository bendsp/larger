import assert from "node:assert/strict";
import test from "node:test";

import {
  createFatalStartupReporter,
  runDesktopStartup,
  runPreReadyStartup,
} from "./fatal-startup.js";

test("pre-ready failures show one generic native error and keep the private cause out of user copy", () => {
  const shown: Array<{ title: string; message: string }> = [];
  const logged: unknown[] = [];
  let quitCount = 0;
  const reporter = createFatalStartupReporter({
    showErrorBox(title, message) { shown.push({ title, message }); },
    logPrivateCause(_message, cause) { logged.push(cause); },
    quit() { quitCount += 1; },
  });

  const result = runPreReadyStartup(() => {
    throw new Error("private path /Users/example/secret");
  }, reporter);

  assert.equal(result, undefined);
  assert.equal(shown.length, 1);
  assert.equal(shown[0]?.title, "Larger could not start");
  assert.doesNotMatch(shown[0]?.message ?? "", /Users|secret/);
  assert.equal(logged.length, 1);
  assert.equal(quitCount, 1);
});

test("desktop-composition failures use the same idempotent native fallback", async () => {
  const shown: string[] = [];
  const logged: unknown[] = [];
  let quitCount = 0;
  const reporter = createFatalStartupReporter({
    showErrorBox(_title, message) { shown.push(message); },
    logPrivateCause(_message, cause) { logged.push(cause); },
    quit() { quitCount += 1; },
  });

  const result = await runDesktopStartup(async () => {
    throw new Error("private composition failure");
  }, reporter);
  reporter.report(new Error("late duplicate failure"));

  assert.equal(result, undefined);
  assert.equal(shown.length, 1);
  assert.equal(quitCount, 1);
  assert.equal(logged.length, 2);
  assert.doesNotMatch(shown[0] ?? "", /private|composition|late/);
});
