import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileOwnershipStore } from "./ownership-store.js";
import { RedactingLogBuffer } from "./redacting-log-buffer.js";
import type { RuntimeProcessIdentity } from "../../src/runtime-contracts.js";
import type { OwnershipStore, RuntimeOwnershipRecord } from "./ownership-store.js";
import {
  DarwinProcessInspector,
  DarwinProcessSupervisor,
  type ProcessInspector,
  type SupervisedProcess,
} from "./process-supervisor.js";

class MemoryOwnershipStore implements OwnershipStore {
  readonly records = new Map<string, RuntimeOwnershipRecord>();
  async put(record: RuntimeOwnershipRecord): Promise<void> { this.records.set(record.id, record); }
  async remove(id: string): Promise<void> { this.records.delete(id); }
  async list(): Promise<readonly RuntimeOwnershipRecord[]> { return [...this.records.values()]; }
}

function record(process: RuntimeProcessIdentity): RuntimeOwnershipRecord {
  return {
    formatVersion: 1,
    id: "session.runtime",
    sessionId: "session",
    role: "runtime",
    nonce: "b".repeat(64),
    projectInstanceKey: "project",
    projectGeneration: 1,
    runtimeId: "runtime",
    runtimePath: "/tmp/runtime",
    state: "running",
    createdAt: "2026-08-11T00:00:00.000Z",
    supervisor: null,
    process,
  };
}

test("recovery never signals a reused PID with a different start identity", async () => {
  const ownership = new MemoryOwnershipStore();
  const expected: RuntimeProcessIdentity = {
    pid: 4242,
    executable: "/usr/bin/node",
    startedAt: "2026-08-11T00:00:00.000Z",
    processGroupId: 4242,
  };
  await ownership.put(record(expected));
  const inspector: ProcessInspector = {
    async inspect() {
      return { ...expected, startedAt: "2026-08-11T00:01:00.000Z" };
    },
  };
  const signals: Array<[number, NodeJS.Signals]> = [];
  const supervisor = new DarwinProcessSupervisor({
    ownership,
    inspector,
    platform: "darwin",
    signalProcess: (pid, signal) => { signals.push([pid, signal]); },
  });

  assert.deepEqual(await supervisor.recover(), [{ recordId: "session.runtime", status: "ownership-mismatch" }]);
  assert.deepEqual(signals, []);
  assert.equal(ownership.records.has("session.runtime"), true);
});

test("recovery cleans a still-owned process group after its recorded leader exits", async () => {
  const ownership = new MemoryOwnershipStore();
  const expected: RuntimeProcessIdentity = {
    pid: 4242,
    executable: "/usr/bin/node",
    startedAt: "2026-08-11T00:00:00.000Z",
    processGroupId: 4242,
  };
  await ownership.put(record(expected));
  let groupExists = true;
  const signals: Array<[number, NodeJS.Signals]> = [];
  const supervisor = new DarwinProcessSupervisor({
    ownership,
    inspector: { inspect: async () => undefined },
    platform: "darwin",
    processGroupExists: () => groupExists,
    signalProcess: (pid, signal) => {
      signals.push([pid, signal]);
      groupExists = false;
    },
    delay: async () => undefined,
  });

  assert.deepEqual(await supervisor.recover(), [{ recordId: "session.runtime", status: "cleaned" }]);
  assert.deepEqual(signals, [[-4242, "SIGTERM"]]);
  assert.equal(ownership.records.has("session.runtime"), false);
});

test("managed launching is feature-gated outside Darwin", () => {
  const supervisor = new DarwinProcessSupervisor({
    ownership: new MemoryOwnershipStore(),
    inspector: { inspect: async () => undefined },
    platform: "win32",
  });
  assert.equal(supervisor.managedLaunchSupported, false);
});

test("Darwin sidecar stops a runtime process group including descendants", { skip: process.platform !== "darwin" }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-supervisor-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const supervisor = new DarwinProcessSupervisor({
    ownership: new FileOwnershipStore(path.join(temporary, "ownership")),
    platform: "darwin",
    executable: process.execPath,
    electronRunAsNode: false,
  });
  const logs = new RedactingLogBuffer();
  const controller = new AbortController();
  const childSource = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    "console.log('grandchild=' + child.pid)",
    "setInterval(() => {}, 1000)",
  ].join(";");
  const managed = await supervisor.spawn({
    sessionId: "00000000-0000-4000-8000-000000000001",
    role: "runtime",
    projectInstanceKey: "project",
    projectGeneration: 1,
    runtimeId: "runtime",
    runtimePath: temporary,
    spec: { command: process.execPath, args: ["--eval", childSource], cwd: temporary, environment: {} },
    logs,
    signal: controller.signal,
  });
  t.after(() => supervisor.stop(managed).catch(() => undefined));
  const deadline = Date.now() + 2_000;
  let grandchild = 0;
  while (!grandchild && Date.now() < deadline) {
    const match = /grandchild=(\d+)/.exec(logs.window().entries.map((entry) => entry.message).join("\n"));
    grandchild = match ? Number(match[1]) : 0;
    if (!grandchild) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(grandchild > 0);
  await supervisor.stop(managed);
  const inspector = new DarwinProcessInspector();
  assert.equal(await inspector.inspect(managed.identity.pid), undefined);
  assert.equal(await inspector.inspect(grandchild), undefined);
});

test("Darwin sidecar treats parent transport EOF as a crash and cleans its process group", { skip: process.platform !== "darwin" }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-supervisor-crash-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const supervisor = new DarwinProcessSupervisor({
    ownership: new FileOwnershipStore(path.join(temporary, "ownership")),
    platform: "darwin",
    executable: process.execPath,
    electronRunAsNode: false,
  });
  const logs = new RedactingLogBuffer();
  const managed = await supervisor.spawn({
    sessionId: "00000000-0000-4000-8000-000000000002",
    role: "runtime",
    projectInstanceKey: "project",
    projectGeneration: 1,
    runtimeId: "runtime",
    runtimePath: temporary,
    spec: {
      command: process.execPath,
      args: ["--eval", "setInterval(() => {}, 1000)"],
      cwd: temporary,
      environment: {},
    },
    logs,
    signal: new AbortController().signal,
  });
  const internal = managed as SupervisedProcess & { readonly sidecar: { readonly stdin: { end(): void } } };
  internal.sidecar.stdin.end();
  await managed.exit;
  assert.equal(await new DarwinProcessInspector().inspect(managed.identity.pid), undefined);
});

test("Darwin hard sidecar death retains ownership for restart recovery", { skip: process.platform !== "darwin" }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-supervisor-hard-crash-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const ownership = new FileOwnershipStore(path.join(temporary, "ownership"));
  const supervisor = new DarwinProcessSupervisor({
    ownership,
    platform: "darwin",
    executable: process.execPath,
    electronRunAsNode: false,
  });
  const managed = await supervisor.spawn({
    sessionId: "00000000-0000-4000-8000-000000000003",
    role: "runtime",
    projectInstanceKey: "project",
    projectGeneration: 1,
    runtimeId: "runtime",
    runtimePath: temporary,
    spec: {
      command: process.execPath,
      args: ["--eval", "setInterval(() => {}, 1000)"],
      cwd: temporary,
      environment: {},
    },
    logs: new RedactingLogBuffer(),
    signal: new AbortController().signal,
  });
  const internal = managed as SupervisedProcess & { readonly sidecar: { kill(signal: string): void } };
  internal.sidecar.kill("SIGKILL");
  await managed.exit;
  const retained = await ownership.list();
  assert.equal(retained.length, 1);
  const recordId = retained[0]!.id;

  const relaunched = new DarwinProcessSupervisor({
    ownership,
    platform: "darwin",
    executable: process.execPath,
    electronRunAsNode: false,
  });
  assert.deepEqual(await relaunched.recover(), [{
    recordId,
    status: "cleaned",
  }]);
  assert.equal(await new DarwinProcessInspector().inspect(managed.identity.pid), undefined);
  assert.equal((await ownership.list()).length, 0);
});

test("stop cleans a retained process group after hard sidecar death and leader exit", { skip: process.platform !== "darwin" }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-supervisor-leader-exit-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const ownership = new FileOwnershipStore(path.join(temporary, "ownership"));
  const supervisor = new DarwinProcessSupervisor({
    ownership,
    platform: "darwin",
    executable: process.execPath,
    electronRunAsNode: false,
  });
  const logs = new RedactingLogBuffer();
  const targetSource = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' })",
    "console.log('grandchild=' + child.pid)",
    "setTimeout(() => process.exit(0), 500)",
  ].join(";");
  const managed = await supervisor.spawn({
    sessionId: "00000000-0000-4000-8000-000000000004",
    role: "runtime",
    projectInstanceKey: "project",
    projectGeneration: 1,
    runtimeId: "runtime",
    runtimePath: temporary,
    spec: {
      command: process.execPath,
      args: ["--eval", targetSource],
      cwd: temporary,
      environment: {},
    },
    logs,
    signal: new AbortController().signal,
  });
  const processGroupId = managed.identity.processGroupId;
  t.after(() => {
    if (processGroupId === null) return;
    try { process.kill(-processGroupId, "SIGKILL"); } catch { /* already cleaned */ }
  });

  let grandchild = 0;
  const logDeadline = Date.now() + 2_000;
  while (!grandchild && Date.now() < logDeadline) {
    const match = /grandchild=(\d+)/.exec(logs.window().entries.map((entry) => entry.message).join("\n"));
    grandchild = match ? Number(match[1]) : 0;
    if (!grandchild) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(grandchild > 0);

  const internal = managed as SupervisedProcess & { readonly sidecar: { kill(signal: string): void } };
  internal.sidecar.kill("SIGKILL");
  await managed.exit;
  const inspector = new DarwinProcessInspector();
  const leaderDeadline = Date.now() + 2_000;
  while (await inspector.inspect(managed.identity.pid) && Date.now() < leaderDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await inspector.inspect(managed.identity.pid), undefined);
  assert.notEqual(await inspector.inspect(grandchild), undefined);
  assert.equal((await ownership.list()).length, 1);

  await supervisor.stop(managed);
  assert.equal(await inspector.inspect(grandchild), undefined);
  assert.equal((await ownership.list()).length, 0);
});
