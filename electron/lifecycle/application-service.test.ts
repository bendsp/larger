import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationService } from "./application-service.js";

const BOOT_ID = "11111111-1111-4111-8111-111111111111";

test("application service publishes monotonic recovery and ready state", async () => {
  let attempts = 0;
  const revisions: number[] = [];
  const service = new ApplicationService({
    bootId: BOOT_ID,
    retry: async () => { attempts += 1; },
    quit: () => undefined,
  });
  service.subscribe((snapshot) => revisions.push(snapshot.revision));
  service.markUnavailable(new Error("runtime recovery failed at /Users/example/private-project"));
  assert.equal(service.snapshot().problem?.message, "The desktop services could not be started.");
  assert.doesNotMatch(JSON.stringify(service.snapshot().problem), /Users|private-project/);

  const recovered = await service.retry();
  assert.equal(attempts, 1);
  assert.equal(recovered.phase, "ready");
  assert.deepEqual(revisions, [1, 2, 3]);
  assert.ok(Object.values(recovered.services).every(({ status }) => status === "ready"));
});

test("degraded services remain visible without blocking the application", () => {
  const service = new ApplicationService({ bootId: BOOT_ID, retry: async () => undefined, quit: () => undefined });
  service.setService("editor", "degraded", {
    code: "unavailable",
    message: "Editor adapter is unavailable",
    retryable: true,
  });
  service.markReady();

  assert.equal(service.snapshot().phase, "degraded");
  assert.equal(service.snapshot().services.editor.status, "degraded");
});

test("quit publishes shutting-down before invoking the host", async () => {
  let phaseDuringQuit = "";
  let service!: ApplicationService;
  service = new ApplicationService({
    bootId: BOOT_ID,
    retry: async () => undefined,
    quit: () => { phaseDuringQuit = service.snapshot().phase; },
  });
  await service.quit();

  assert.equal(phaseDuringQuit, "shutting-down");
});
