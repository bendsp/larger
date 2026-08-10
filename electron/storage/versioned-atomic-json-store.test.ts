import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VersionedAtomicJsonStore, type JsonStoreCodec } from "./versioned-atomic-json-store.js";

interface CounterState { schemaVersion: 1; count: number }

const codec: JsonStoreCodec<CounterState> = {
  createDefault: () => ({ schemaVersion: 1, count: 0 }),
  decode(value) {
    if (
      typeof value !== "object" || value === null
      || (value as Record<string, unknown>).schemaVersion !== 1
      || !Number.isInteger((value as Record<string, unknown>).count)
    ) throw new Error("invalid counter store");
    return value as CounterState;
  },
  encode(value) { return this.decode(value); },
};

test("atomically creates and reads a private JSON store", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "nested", "state.json");
  const store = new VersionedAtomicJsonStore(file, codec);
  assert.deepEqual(await store.read(), { status: "missing", value: { schemaVersion: 1, count: 0 } });
  await store.write({ schemaVersion: 1, count: 4 });
  assert.deepEqual(await store.read(), { status: "loaded", value: { schemaVersion: 1, count: 4 } });
  assert.equal(JSON.parse(await readFile(file, "utf8")).count, 4);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")), []);
});

test("serializes concurrent updates without losing writes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new VersionedAtomicJsonStore(path.join(root, "state.json"), codec);
  await Promise.all(Array.from({ length: 25 }, () => store.update((state) => ({ ...state, count: state.count + 1 }))));
  assert.equal((await store.read()).value.count, 25);
});

test("an aborted operation cannot publish a JSON store update", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "state.json");
  const store = new VersionedAtomicJsonStore(file, codec);
  await store.write({ schemaVersion: 1, count: 1 });
  const controller = new AbortController();
  controller.abort(new Error("superseded"));
  await assert.rejects(
    store.update((state) => ({ ...state, count: 2 }), { signal: controller.signal }),
    /superseded/,
  );
  assert.equal((await store.read()).value.count, 1);
});

test("preserves corrupt input before recovering to a default", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "state.json");
  await writeFile(file, "not json", "utf8");
  const result = await new VersionedAtomicJsonStore(file, codec).read();
  assert.equal(result.status, "recovered-corruption");
  if (result.status !== "recovered-corruption") return;
  assert.equal(await readFile(result.recoveredPath, "utf8"), "not json");
  assert.deepEqual(result.value, { schemaVersion: 1, count: 0 });
});

test("can surface corruption without moving the source file", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "state.json");
  await writeFile(file, "{}", "utf8");
  const store = new VersionedAtomicJsonStore(file, codec, { recoverCorruption: false });
  await assert.rejects(store.read(), /invalid counter store/);
  assert.equal(await readFile(file, "utf8"), "{}");
});
