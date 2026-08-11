import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow } from "electron";
import type { ZodType } from "zod";
import type { RuntimeOperationResult, RuntimeWorkspaceSnapshot } from "../../src/runtime-contracts.js";
import { RUNTIME_IPC_CHANNELS } from "../../src/runtime-ipc.js";
import type {
  DesktopIpcOperation,
  DesktopIpcRouter,
} from "./desktop-ipc-router.js";
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

test("runtime IPC registers typed operations and validates published snapshots", async () => {
  const operations = new Map<string, DesktopIpcOperation<unknown, unknown>>();
  const published: unknown[] = [];
  const disposed: string[] = [];
  const router = {
    register: (operation: DesktopIpcOperation<unknown, unknown>) => {
      operations.set(operation.channel, operation);
      return () => {
        operations.delete(operation.channel);
        disposed.push(operation.channel);
      };
    },
    publish: <T>(
      _window: BrowserWindow | null,
      channel: string,
      stream: string,
      schema: ZodType<T>,
      value: T,
    ) => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) return false;
      published.push({ channel, stream, payload: parsed.data });
      return true;
    },
  } as unknown as DesktopIpcRouter;
  let listener: ((value: RuntimeWorkspaceSnapshot) => void) | undefined;
  let discoverCalls = 0;
  const signals = new Map<string, AbortSignal | undefined>();
  const completed = (): RuntimeOperationResult => ({ status: "completed", snapshot: snapshot() });
  const service: RuntimeServicePort = {
    snapshot,
    start: async (_generation, _profileName, _revision, options) => { signals.set("start", options?.signal); return completed(); },
    attach: async (_generation, _url, _revision, options) => { signals.set("attach", options?.signal); return completed(); },
    discover: async (_generation, _revision, options) => { signals.set("discover", options?.signal); discoverCalls += 1; return completed(); },
    cancel: async (_generation, _operationId, options) => { signals.set("cancel", options?.signal); return completed(); },
    stop: async (_generation, _sessionId, _revision, options) => { signals.set("stop", options?.signal); return completed(); },
    detach: async (_generation, _sessionId, _revision, options) => { signals.set("detach", options?.signal); return completed(); },
    restart: async (_generation, _sessionId, _revision, options) => { signals.set("restart", options?.signal); return completed(); },
    subscribe: (next) => {
      listener = next;
      return () => { listener = undefined; };
    },
  };
  const dispose = registerRuntimeIpc({
    router,
    service,
    getWindow: () => ({}) as BrowserWindow,
  });

  const discover = operations.get(RUNTIME_IPC_CHANNELS.discover)!;
  const input = discover.input.parse({ generation: 2, expectedRevision: 1 });
  const controller = new AbortController();
  const context = { signal: controller.signal } as never;
  const result = await discover.run(input, context);
  assert.deepEqual(discover.output.parse(result), completed());
  assert.equal(discoverCalls, 1);
  assert.equal(signals.get("discover"), controller.signal);
  assert.equal(discover.input.safeParse({ generation: 2, expectedRevision: 1, extra: true }).success, false);

  const sessionId = "10000000-0000-4000-8000-000000000001";
  const operationId = "10000000-0000-4000-8000-000000000002";
  const mutationCases = [
    ["start", RUNTIME_IPC_CHANNELS.start, { generation: 2, profileName: "dev", expectedRevision: 1 }],
    ["attach", RUNTIME_IPC_CHANNELS.attach, { generation: 2, url: "http://127.0.0.1:3000", expectedRevision: 1 }],
    ["cancel", RUNTIME_IPC_CHANNELS.cancel, { generation: 2, operationId }],
    ["stop", RUNTIME_IPC_CHANNELS.stop, { generation: 2, sessionId, expectedRevision: 1 }],
    ["detach", RUNTIME_IPC_CHANNELS.detach, { generation: 2, sessionId, expectedRevision: 1 }],
    ["restart", RUNTIME_IPC_CHANNELS.restart, { generation: 2, sessionId, expectedRevision: 1 }],
  ] as const;
  for (const [name, channel, payload] of mutationCases) {
    const operation = operations.get(channel)!;
    await operation.run(operation.input.parse(payload), context);
    assert.equal(signals.get(name), controller.signal, `${name} must receive the renderer document lease`);
  }

  listener?.(snapshot());
  listener?.({ ...snapshot(), projectInstanceKey: null });
  assert.equal(published.length, 1);
  assert.deepEqual(published[0], {
    channel: RUNTIME_IPC_CHANNELS.snapshot,
    stream: "runtime.snapshot",
    payload: snapshot(),
  });

  dispose();
  assert.equal(listener, undefined);
  assert.deepEqual(disposed.sort(), Object.values(RUNTIME_IPC_CHANNELS)
    .filter((channel) => channel !== RUNTIME_IPC_CHANNELS.snapshot)
    .sort());
});
