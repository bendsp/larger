import assert from "node:assert/strict";
import test from "node:test";
import type {
  ProcessExit,
  ProcessSupervisor,
  SpawnSupervisedProcessInput,
  SupervisedProcess,
} from "../../runtime/process-supervisor.js";
import { SupervisedDependencyCommandRunner } from "./supervised-command-runner.js";

function controlledSupervisor(): {
  readonly supervisor: ProcessSupervisor;
  readonly spawned: SpawnSupervisedProcessInput[];
  finish(result: ProcessExit): void;
  readonly stops: SupervisedProcess[];
} {
  const spawned: SpawnSupervisedProcessInput[] = [];
  const stops: SupervisedProcess[] = [];
  let finish: (result: ProcessExit) => void = () => undefined;
  const exit = new Promise<ProcessExit>((resolve) => { finish = resolve; });
  const process: SupervisedProcess = {
    identity: {
      pid: 4242,
      executable: "/usr/bin/node",
      startedAt: "2026-08-11T00:00:00.000Z",
      processGroupId: 4242,
    },
    role: "runtime",
    exit,
  };
  return {
    spawned,
    stops,
    finish,
    supervisor: {
      managedLaunchSupported: true,
      async spawn(input) {
        spawned.push(input);
        input.onOutput?.("stdout", Buffer.from("9.9.9\n"));
        input.onOutput?.("stderr", Buffer.from("warning\n"));
        return process;
      },
      async stop(candidate) {
        stops.push(candidate);
        finish({ code: null, signal: "SIGTERM" });
      },
      async recover() { return []; },
    },
  };
}

test("dependency commands use opaque durable supervision and capture bounded output", async () => {
  const controlled = controlledSupervisor();
  const runner = new SupervisedDependencyCommandRunner({
    supervisor: controlled.supervisor,
    projectInstanceKey: "project-instance",
  });
  const resultPromise = runner.run({
    executable: "/usr/bin/pnpm",
    arguments: ["--version"],
    cwd: "/tmp/runtime",
    environment: { PATH: "/usr/bin", OMITTED: undefined },
  });
  controlled.finish({ code: 0, signal: null });
  assert.deepEqual(await resultPromise, { stdout: "9.9.9\n", stderr: "warning\n" });
  assert.equal(controlled.spawned.length, 1);
  assert.match(controlled.spawned[0]!.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(controlled.spawned[0]!.projectInstanceKey, "project-instance");
  assert.deepEqual(controlled.spawned[0]!.spec.environment, { PATH: "/usr/bin" });
});

test("dependency command cancellation stops the owned process group", async () => {
  const controlled = controlledSupervisor();
  const runner = new SupervisedDependencyCommandRunner({
    supervisor: controlled.supervisor,
    projectInstanceKey: "project-instance",
  });
  const controller = new AbortController();
  const result = runner.run({
    executable: "/usr/bin/pnpm",
    arguments: ["install"],
    cwd: "/tmp/runtime",
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(result, /cancelled/);
  assert.equal(controlled.stops.length, 1);
});
