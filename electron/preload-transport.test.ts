import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { z } from "zod";

import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_PROTOCOL_VERSION,
  type DesktopRequestEnvelope,
} from "../src/desktop/protocol.js";
import { createPreloadTransport, type PreloadIpcRenderer } from "./preload-transport.js";

const bootId = "10000000-0000-4000-8000-000000000000";
const clientId = "20000000-0000-4000-8000-000000000000";
let id = 2;

function nextId(): string {
  id += 1;
  return `${id.toString().padStart(8, "0")}-0000-4000-8000-000000000000`;
}

function success<T>(request: DesktopRequestEnvelope<unknown>, value: T) {
  return {
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    requestId: request.requestId,
    bootId,
    ok: true as const,
    value,
  };
}

class FakeIpcRenderer extends EventEmitter implements PreloadIpcRenderer {
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  responder: (channel: string, payload: DesktopRequestEnvelope<unknown>) => unknown = (channel, payload) => {
    if (channel === DESKTOP_IPC_CHANNELS.connect) {
      return success(payload, {
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        bootId,
        clientId: payload.clientId,
      });
    }
    return success(payload, { value: 1 });
  };

  async invoke(channel: string, payload: unknown): Promise<unknown> {
    return this.responder(channel, payload as DesktopRequestEnvelope<unknown>);
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }

  override on(channel: string, listener: (event: unknown, raw: unknown) => void): this {
    return super.on(channel, listener);
  }

  override removeListener(channel: string, listener: (event: unknown, raw: unknown) => void): this {
    return super.removeListener(channel, listener);
  }
}

function transport(renderer: FakeIpcRenderer, failures: unknown[] = []) {
  let first = true;
  return createPreloadTransport({
    ipcRenderer: renderer,
    createId: () => {
      if (first) {
        first = false;
        return clientId;
      }
      return nextId();
    },
    reportFailure: (cause) => { failures.push(cause); },
  });
}

test("preload transport rejects mismatched request and boot identities", async () => {
  const renderer = new FakeIpcRenderer();
  const value = transport(renderer);
  renderer.responder = (_channel, payload) => ({
    ...success(payload, { value: 1 }),
    requestId: "90000000-0000-4000-8000-000000000000",
  });
  await assert.rejects(value.invoke("test:operation", z.object({ value: z.number() }), {}), /stale or mismatched/);

  renderer.responder = (_channel, payload) => ({
    ...success(payload, { value: 1 }),
    bootId: "90000000-0000-4000-8000-000000000000",
  });
  await assert.rejects(value.invoke("test:operation", z.object({ value: z.number() }), {}), /stale or mismatched/);
});

test("preload transport accepts only current monotonic events and removes its exact listener", async () => {
  const renderer = new FakeIpcRenderer();
  const failures: unknown[] = [];
  const value = transport(renderer, failures);
  const seen: number[] = [];
  const unsubscribe = value.subscribe("test:event", "test.snapshot", z.object({ revision: z.number() }), (event) => {
    seen.push(event.revision);
  });
  const event = (sequence: number, revision: number, overrides: Record<string, unknown> = {}) => ({
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    bootId,
    clientId,
    stream: "test.snapshot",
    sequence,
    payload: { revision },
    ...overrides,
  });

  renderer.emit("test:event", {}, event(1, 1));
  renderer.emit("test:event", {}, event(1, 2));
  renderer.emit("test:event", {}, event(2, 3, { bootId: "90000000-0000-4000-8000-000000000000" }));
  renderer.emit("test:event", {}, event(2, 4, { clientId: "90000000-0000-4000-8000-000000000000" }));
  renderer.emit("test:event", {}, event(2, 5));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [1, 5]);
  assert.deepEqual(failures, []);

  unsubscribe();
  renderer.emit("test:event", {}, event(3, 6));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [1, 5]);
  assert.equal(renderer.listenerCount("test:event"), 0);
});
