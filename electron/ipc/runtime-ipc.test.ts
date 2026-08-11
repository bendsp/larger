import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { RuntimeOperationResult, RuntimeWorkspaceSnapshot } from "../../src/runtime-contracts.js";
import { RUNTIME_IPC_CHANNELS } from "../../src/runtime-ipc.js";
import { registerRuntimeIpc, type RuntimeServicePort } from "./runtime-ipc.js";

function snapshot(): RuntimeWorkspaceSnapshot {
  return {
    formatVersion: 1,
    revision: 1,
    projectGeneration: 2,
    projectInstanceKey: "instance-key",
    profiles: [],
    phase: "idle",
    operation: null,
    session: null,
    discovery: null,
    logWindow: {
      entries: [],
      earliestId: null,
      latestId: null,
      retained: 0,
      limit: 500,
      truncated: false,
    },
    problem: null,
  };
}

test("runtime IPC validates calls, results, and published snapshots", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>();
  const removed: string[] = [];
  const sent: unknown[][] = [];
  let published: ((value: RuntimeWorkspaceSnapshot) => void) | undefined;
  let current: RuntimeWorkspaceSnapshot | unknown = snapshot();
  let discoverCalls = 0;
  const completed = (): RuntimeOperationResult => ({ status: "completed", snapshot: snapshot() });
  const service: RuntimeServicePort = {
    snapshot: () => current as RuntimeWorkspaceSnapshot,
    start: async () => completed(),
    attach: async () => completed(),
    discover: async () => { discoverCalls += 1; return completed(); },
    cancel: async () => completed(),
    stop: async () => completed(),
    detach: async () => completed(),
    restart: async () => completed(),
    subscribe: (listener) => { published = listener; return () => { published = undefined; }; },
  };
  const ipcMain = {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => { removed.push(channel); },
  } as unknown as IpcMain;
  const window = {
    isDestroyed: () => false,
    webContents: { send: (...args: unknown[]) => { sent.push(args); } },
  } as unknown as BrowserWindow;
  let trustedCalls = 0;
  const dispose = registerRuntimeIpc({
    ipcMain,
    service,
    getWindow: () => window,
    assertTrustedSender: () => { trustedCalls += 1; },
  });
  const event = {} as IpcMainInvokeEvent;

  const valid = await handlers.get(RUNTIME_IPC_CHANNELS.discover)!(event, {
    generation: 2,
    expectedRevision: 1,
  });
  assert.deepEqual(valid, { ok: true, value: completed() });
  assert.equal(discoverCalls, 1);

  const invalid = await handlers.get(RUNTIME_IPC_CHANNELS.discover)!(event, {
    generation: 2,
    expectedRevision: 1,
    unexpected: true,
  }) as { ok: boolean; error: { code: string } };
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid-ipc-payload");
  assert.equal(discoverCalls, 1);

  current = { ...snapshot(), unexpected: true };
  const invalidOutput = await handlers.get(RUNTIME_IPC_CHANNELS.getSnapshot)!(event, { generation: 2 }) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(invalidOutput.ok, false);
  assert.equal(invalidOutput.error.code, "invalid-ipc-payload");

  published?.(snapshot());
  published?.({ ...snapshot(), projectInstanceKey: null });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], [RUNTIME_IPC_CHANNELS.snapshot, snapshot()]);
  assert.equal(trustedCalls, 3);

  dispose();
  assert.equal(published, undefined);
  assert.deepEqual(removed.sort(), Object.values(RUNTIME_IPC_CHANNELS).filter((channel) => channel !== RUNTIME_IPC_CHANNELS.snapshot).sort());
});
