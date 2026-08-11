import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareDesktopPaths } from "./desktop-paths.js";
import { createLifecycleLogger } from "./lifecycle-logger.js";

test("lifecycle logs redact secrets, bound records, and rotate", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-lifecycle-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await prepareDesktopPaths(path.join(root, "user-data"));
  let tick = 0;
  const logger = await createLifecycleLogger({
    logsRoot: paths.logsRoot,
    maxFileBytes: 260,
    maxRecordBytes: 180,
    maxFiles: 3,
    now: () => new Date(1_700_000_000_000 + tick++),
  });
  logger.addSecrets(["secret-token"]);
  await logger.write({ level: "info", event: "desktop.starting", message: "using secret-token", details: { token: "secret-token" } });
  await logger.write({ level: "warning", event: "desktop.recovery", message: "x".repeat(1_000) });
  await logger.close();

  const current = await readFile(path.join(paths.logsRoot, "lifecycle.jsonl"), "utf8");
  const previous = await readFile(path.join(paths.logsRoot, "lifecycle.jsonl.1"), "utf8");
  assert.match(previous, /\[REDACTED\]/);
  assert.doesNotMatch(`${current}${previous}`, /secret-token/);
  assert.match(current, /oversized lifecycle record omitted/);
  assert.ok(Buffer.byteLength(current) <= 180);
});

test("lifecycle logging rejects a symlinked destination", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-lifecycle-log-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await prepareDesktopPaths(path.join(root, "user-data"));
  const outside = path.join(root, "outside.log");
  await writeFile(outside, "outside\n");
  await symlink(outside, path.join(paths.logsRoot, "lifecycle.jsonl"));
  const logger = await createLifecycleLogger({ logsRoot: paths.logsRoot });
  await assert.rejects(logger.write({ level: "error", event: "desktop.failure", message: "failure" }), /regular file/);
  assert.equal(await readFile(outside, "utf8"), "outside\n");
});

test("lifecycle rotation replaces an existing empty destination", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-lifecycle-log-empty-rotation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await prepareDesktopPaths(path.join(root, "user-data"));
  const logger = await createLifecycleLogger({
    logsRoot: paths.logsRoot,
    maxFileBytes: 200,
    maxRecordBytes: 180,
    maxFiles: 3,
  });
  const record = { level: "info", event: "desktop.rotation", message: "x".repeat(80) } as const;
  await logger.write(record);
  await logger.write(record);
  await writeFile(path.join(paths.logsRoot, "lifecycle.jsonl.2"), "");
  await logger.write(record);
  await logger.close();

  assert.notEqual(await readFile(path.join(paths.logsRoot, "lifecycle.jsonl.2"), "utf8"), "");
});

test("lifecycle record limit cannot exceed its file limit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-lifecycle-log-limits-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await prepareDesktopPaths(path.join(root, "user-data"));
  await assert.rejects(
    createLifecycleLogger({ logsRoot: paths.logsRoot, maxFileBytes: 100, maxRecordBytes: 101 }),
    /cannot exceed/,
  );
});
