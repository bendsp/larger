import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type {
  BrowserWindow,
  IpcMain,
  IpcMainInvokeEvent,
} from "electron";
import { z } from "zod";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_PROTOCOL_VERSION,
  type DesktopRequestEnvelope,
  type DesktopResponseEnvelope,
} from "../../src/desktop/protocol.js";
import { DesktopIpcRouter } from "./desktop-ipc-router.js";
import { RendererSessionRegistry } from "./renderer-session-registry.js";

const bootId = "10000000-0000-4000-8000-000000000000";
const clientId = "20000000-0000-4000-8000-000000000000";
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `30000000-0000-4000-8000-${requestCounter.toString().padStart(12, "0")}`;
}

function request<T>(client: string, payload: T): DesktopRequestEnvelope<T> {
  return {
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    requestId: nextRequestId(),
    clientId: client,
    payload,
  };
}

class FakeWebContents extends EventEmitter {
  constructor(readonly id = 41) { super(); }
  readonly mainFrame = {};
  readonly sent: unknown[][] = [];
  isDestroyed(): boolean { return false; }
  send(...args: unknown[]): void { this.sent.push(args); }
}

function harness() {
  const invokeHandlers = new Map<string, (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>>();
  const commandEmitter = new EventEmitter();
  const removedHandlers: string[] = [];
  const ipcMain = {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>) => {
      invokeHandlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      invokeHandlers.delete(channel);
      removedHandlers.push(channel);
    },
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      commandEmitter.on(channel, listener);
      return ipcMain;
    },
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
      commandEmitter.removeListener(channel, listener);
      return ipcMain;
    },
  } as unknown as IpcMain;
  const contents = new FakeWebContents();
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent;
  const sessions = new RendererSessionRegistry(bootId);
  const violations: Error[] = [];
  const unexpected: unknown[] = [];
  const router = new DesktopIpcRouter({
    ipcMain,
    sessions,
    assertTrustedSender: () => undefined,
    onContractViolation: (error) => violations.push(error),
    onUnexpectedError: (cause) => unexpected.push(cause),
  });
  return {
    invokeHandlers,
    commandEmitter,
    removedHandlers,
    contents,
    event,
    sessions,
    router,
    violations,
    unexpected,
  };
}

async function connect(
  value: ReturnType<typeof harness>,
  id = clientId,
  event = value.event,
): Promise<DesktopResponseEnvelope<unknown>> {
  const raw = request(id, {});
  return value.invokeHandlers.get(DESKTOP_IPC_CHANNELS.connect)!(event, raw) as Promise<DesktopResponseEnvelope<unknown>>;
}

test("desktop router rejects protocol mismatches and subframe sessions", async () => {
  const value = harness();
  const mismatch = request(clientId, {}) as { protocolVersion: number };
  mismatch.protocolVersion = 2;
  const mismatchResult = await value.invokeHandlers.get(DESKTOP_IPC_CHANNELS.connect)!(value.event, mismatch) as DesktopResponseEnvelope<unknown>;
  assert.equal(mismatchResult.ok, false);
  if (!mismatchResult.ok) assert.equal(mismatchResult.error.code, "protocol-mismatch");

  const subframeEvent = {
    sender: value.contents,
    senderFrame: {},
  } as unknown as IpcMainInvokeEvent;
  const subframeResult = await connect(value, clientId, subframeEvent);
  assert.equal(subframeResult.ok, false);
  if (!subframeResult.ok) assert.equal(subframeResult.error.code, "unauthorized");
  value.router.dispose();
});

test("unexpected main-process errors are logged privately and sanitized across IPC", async () => {
  const value = harness();
  await connect(value);
  value.router.register({
    channel: "test:private-error",
    input: z.object({}).strict(),
    output: z.object({}).strict(),
    failureCode: "application-operation-failed",
    run: () => {
      throw new Error("private /Users/example/project path and secret command");
    },
  });

  const result = await value.invokeHandlers.get("test:private-error")!(
    value.event,
    request(clientId, {}),
  ) as DesktopResponseEnvelope<unknown>;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "application-operation-failed");
    assert.equal(result.error.message, "The desktop operation could not be completed.");
    assert.doesNotMatch(JSON.stringify(result.error), /Users|secret command/);
  }
  assert.equal(value.unexpected.length, 1);
  assert.match(String(value.unexpected[0]), /private \/Users\/example/);
  value.router.dispose();
});

test("desktop router validates request and output contracts", async () => {
  const value = harness();
  assert.equal((await connect(value)).ok, true);
  let calls = 0;
  value.router.register({
    channel: "test:validated",
    input: z.object({ value: z.number().int() }).strict(),
    output: z.object({ doubled: z.number().int() }).strict(),
    failureCode: "application-operation-failed",
    run: ({ value: input }) => {
      calls += 1;
      return { doubled: input * 2 };
    },
  });
  const validRequest = request(clientId, { value: 3 });
  const valid = await value.invokeHandlers.get("test:validated")!(value.event, validRequest) as DesktopResponseEnvelope<{ doubled: number }>;
  assert.equal(valid.ok, true);
  if (valid.ok) assert.deepEqual(valid.value, { doubled: 6 });

  const invalid = await value.invokeHandlers.get("test:validated")!(
    value.event,
    request(clientId, { value: 3, unexpected: true }),
  ) as DesktopResponseEnvelope<unknown>;
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "invalid-request");
  assert.equal(calls, 1);

  value.router.register({
    channel: "test:bad-output",
    input: z.object({}).strict(),
    output: z.object({ valid: z.literal(true) }).strict(),
    failureCode: "application-operation-failed",
    run: () => ({ valid: false as true }),
  });
  const invalidOutput = await value.invokeHandlers.get("test:bad-output")!(
    value.event,
    request(clientId, {}),
  ) as DesktopResponseEnvelope<unknown>;
  assert.equal(invalidOutput.ok, false);
  if (!invalidOutput.ok) assert.equal(invalidOutput.error.code, "contract-violation");
  assert.equal(value.violations.length, 1);
  value.router.dispose();
});

test("renderer reload aborts its lease and suppresses the stale response", async () => {
  const value = harness();
  await connect(value);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let mutated = false;
  value.router.register({
    channel: "test:leased",
    input: z.object({}).strict(),
    output: z.object({ mutated: z.boolean() }).strict(),
    failureCode: "project-operation-failed",
    run: async (_input, context) => {
      await gate;
      context.assertCurrent();
      mutated = true;
      return { mutated };
    },
  });
  const pending = value.invokeHandlers.get("test:leased")!(value.event, request(clientId, {}));
  value.contents.emit("did-start-navigation", {}, "http://studio/reload", false, true);
  release();
  const result = await pending as DesktopResponseEnvelope<unknown>;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "stale-client");
  assert.equal(mutated, false);

  const nextClient = "40000000-0000-4000-8000-000000000000";
  assert.equal((await connect(value, nextClient)).ok, true);
  const oldClientResult = await value.invokeHandlers.get("test:leased")!(value.event, request(clientId, {})) as DesktopResponseEnvelope<unknown>;
  assert.equal(oldClientResult.ok, false);
  if (!oldClientResult.ok) assert.equal(oldClientResult.error.code, "stale-client");
  value.router.dispose();
});

test("desktop event publication is current-client scoped, ordered, and output validated", async () => {
  const value = harness();
  await connect(value);
  const window = {
    isDestroyed: () => false,
    webContents: value.contents,
  } as unknown as BrowserWindow;
  const schema = z.object({ revision: z.number().int().nonnegative() }).strict();
  assert.equal(value.router.publish(window, "test:event", "test.snapshot", schema, { revision: 1 }), true);
  assert.equal(value.router.publish(window, "test:event", "test.snapshot", schema, { revision: 2 }), true);
  assert.equal(value.contents.sent.length, 2);
  assert.deepEqual(value.contents.sent.map((entry) => (entry[1] as { sequence: number }).sequence), [1, 2]);
  assert.deepEqual(value.contents.sent.map((entry) => (entry[1] as { clientId: string }).clientId), [clientId, clientId]);
  const sequenceState = (value.router as unknown as { sequences: Map<string, number> }).sequences;
  assert.equal(sequenceState.size, 1);

  const nextClient = "40000000-0000-4000-8000-000000000000";
  assert.equal((await connect(value, nextClient)).ok, true);
  assert.equal(sequenceState.size, 0);
  assert.equal(value.router.publish(window, "test:event", "test.snapshot", schema, { revision: 3 }), true);
  assert.equal((value.contents.sent.at(-1)?.[1] as { sequence: number }).sequence, 1);

  assert.equal(value.router.publish(
    window,
    "test:event",
    "test.snapshot",
    schema,
    { revision: -1 },
  ), false);
  assert.equal(value.contents.sent.length, 3);
  assert.equal(value.violations.length, 1);
  value.router.dispose();
});

test("session registry removes only its own WebContents listeners", async () => {
  const value = harness();
  let unrelated = 0;
  value.contents.on("destroyed", () => { unrelated += 1; });
  await connect(value);
  value.router.dispose();
  value.contents.emit("destroyed");
  assert.equal(unrelated, 1);
  assert.ok(value.removedHandlers.includes(DESKTOP_IPC_CHANNELS.connect));
});

test("in-page navigation keeps the document lease and client ids cannot alias WebContents", async () => {
  const value = harness();
  await connect(value);
  value.contents.emit("did-start-navigation", {}, "http://studio/#changes", true, true);
  assert.equal(value.sessions.currentClientForWebContents(value.contents.id), clientId);

  const otherContents = new FakeWebContents(42);
  const otherEvent = {
    sender: otherContents,
    senderFrame: otherContents.mainFrame,
  } as unknown as IpcMainInvokeEvent;
  assert.equal((await connect(value, clientId, otherEvent)).ok, true);
  assert.equal(value.sessions.currentClientForWebContents(value.contents.id), null);
  assert.equal(value.sessions.currentClientForWebContents(otherContents.id), clientId);
  value.router.dispose();
});
