import assert from "node:assert/strict";
import test from "node:test";

import { DesktopHost, type DesktopHostPhase } from "./desktop-host.js";

test("concurrent shutdown waits for startup and disposes exactly once", async () => {
  let releaseStartup!: () => void;
  const startupGate = new Promise<void>((resolve) => { releaseStartup = resolve; });
  let disposeCount = 0;
  const phases: DesktopHostPhase[] = [];
  const host = new DesktopHost({
    createDesktop: async () => {
      await startupGate;
      return { dispose: async () => { disposeCount += 1; } };
    },
    onPhase: (phase) => phases.push(phase),
  });

  const starting = host.start();
  const firstStop = host.stop();
  const secondStop = host.stop();
  assert.equal(firstStop, secondStop);
  releaseStartup();
  await assert.rejects(starting, /cancelled by shutdown/);
  await firstStop;

  assert.equal(disposeCount, 1);
  assert.equal(host.phase, "stopped");
  assert.deepEqual(phases, ["starting", "stopping", "stopped"]);
});

test("startup failure is observable and shutdown remains idempotent", async () => {
  const failure = new Error("composition failed");
  const host = new DesktopHost({ createDesktop: async () => { throw failure; } });

  await assert.rejects(host.start(), failure);
  assert.equal(host.phase, "failed");
  await host.stop();
  await host.stop();
  assert.equal(host.phase, "stopped");
});
