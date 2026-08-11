import assert from "node:assert/strict";
import test from "node:test";

import { createRendererFailureReporter } from "./renderer-failure.js";

test("renderer failure reporting is visible, private, and deduplicated", async () => {
  const causes: unknown[] = [];
  let prompts = 0;
  let retries = 0;
  let releasePrompt: ((action: "retry" | "quit") => void) | undefined;
  const reporter = createRendererFailureReporter({
    log: (cause) => { causes.push(cause); },
    prompt: () => {
      prompts += 1;
      return new Promise((resolve) => { releasePrompt = resolve; });
    },
    retry: () => { retries += 1; },
    quit: () => assert.fail("retry should not quit"),
  });
  const cause = new Error("private renderer details");
  const first = reporter.report(cause);
  const duplicate = reporter.report(new Error("duplicate"));
  assert.strictEqual(first, duplicate);
  await Promise.resolve();
  assert.equal(prompts, 1);
  releasePrompt?.("retry");
  await first;
  assert.deepEqual(causes, [cause]);
  assert.equal(retries, 1);
});

test("renderer failure reporting can quit when recovery is declined", async () => {
  let quits = 0;
  const reporter = createRendererFailureReporter({
    log: () => undefined,
    prompt: async () => "quit",
    retry: () => assert.fail("quit should not retry"),
    quit: () => { quits += 1; },
  });
  await reporter.report(new Error("gone"));
  assert.equal(quits, 1);
});
