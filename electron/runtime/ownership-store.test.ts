import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileOwnershipStore, type RuntimeOwnershipRecord } from "./ownership-store.js";

test("ownership records publish atomically and round-trip", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-ownership-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "records");
  await mkdir(directory);
  const store = new FileOwnershipStore(directory);
  const record: RuntimeOwnershipRecord = {
    formatVersion: 1,
    id: "session.runtime",
    sessionId: "session",
    role: "runtime",
    nonce: "a".repeat(64),
    projectInstanceKey: "project",
    projectGeneration: 2,
    runtimeId: "runtime",
    runtimePath: path.join(root, "runtime"),
    state: "reserved",
    createdAt: "2026-08-11T00:00:00.000Z",
    supervisor: null,
    process: null,
  };
  await store.put(record);
  assert.deepEqual(await store.list(), [record]);
  assert.equal((await readFile(path.join(directory, "session.runtime.json"), "utf8")).endsWith("\n"), true);
  await store.remove(record.id);
  assert.deepEqual(await store.list(), []);
});
