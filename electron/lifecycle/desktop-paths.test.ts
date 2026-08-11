import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPreReadyElectronPaths, prepareDesktopPaths, prepareDesktopPathsSync } from "./desktop-paths.js";

test("desktop paths are canonical, private, and applied before Electron readiness", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-desktop-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await prepareDesktopPaths(path.join(root, "user-data"));

  for (const directory of Object.values(paths)) {
    const metadata = await lstat(directory);
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.isSymbolicLink(), false);
  }

  const calls: Array<readonly [string, string]> = [];
  applyPreReadyElectronPaths({
    setPath(name, value) { calls.push([name, value]); },
    setAppLogsPath(value) { calls.push(["appLogs", value ?? ""]); },
  }, paths);
  assert.deepEqual(calls, [
    ["sessionData", paths.sessionDataRoot],
    ["crashDumps", paths.crashDumpsRoot],
    ["appLogs", paths.logsRoot],
  ]);
});

test("desktop paths fail closed on symlinked managed children", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-desktop-paths-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = path.join(root, "user-data");
  const outside = path.join(root, "outside");
  await mkdir(userData);
  await mkdir(outside);
  await symlink(outside, path.join(userData, "logs"));
  await assert.rejects(prepareDesktopPaths(userData), /real directory/);
  assert.throws(() => prepareDesktopPathsSync(userData), /real directory/);
});

test("desktop paths can be prepared and applied before the first startup await", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-desktop-paths-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: Array<readonly [string, string]> = [];

  const paths = prepareDesktopPathsSync(path.join(root, "user-data"));
  applyPreReadyElectronPaths({
    setPath(name, value) { calls.push([name, value]); },
    setAppLogsPath(value) { calls.push(["appLogs", value ?? ""]); },
  }, paths);

  assert.deepEqual(calls, [
    ["sessionData", paths.sessionDataRoot],
    ["crashDumps", paths.crashDumpsRoot],
    ["appLogs", paths.logsRoot],
  ]);
});
