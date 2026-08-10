import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WindowStateStore, windowStateCodec } from "./window-state-store.js";

test("window state is validated and persists under application data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-window-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WindowStateStore(path.join(root, "window.json"));
  const state = { schemaVersion: 1 as const, bounds: { x: 120, y: 90, width: 1440, height: 900 }, maximized: true };
  await store.write(state);
  assert.deepEqual((await store.read()).value, state);
  assert.throws(() => windowStateCodec.decode({ ...state, bounds: { ...state.bounds, width: 1 } }), /outside supported limits/);
});
