import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { _electron as electron } from "playwright-core";

async function buildFixtureMain(temporary: string): Promise<string> {
  const fixtureMain = path.join(temporary, "fixture-main.cjs");
  await build({
    entryPoints: [path.resolve("test/electron/fixture-main.ts")],
    outfile: fixtureMain,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["electron"],
  });
  return fixtureMain;
}

async function writeProject(projectPath: string, projectId: string, name: string, initialized = true): Promise<void> {
  await mkdir(projectPath, { recursive: true });
  await writeFile(path.join(projectPath, "package.json"), JSON.stringify({
    packageManager: "pnpm@10",
    scripts: { dev: "vite" },
    devDependencies: { vite: "1" },
  }));
  if (!initialized) return;
  await mkdir(path.join(projectPath, ".larger"));
  await writeFile(path.join(projectPath, ".larger", "project.json"), `${JSON.stringify({
    schemaVersion: 1,
    projectId,
    name,
    defaultRuntimeProfile: "dev",
    runtimeProfiles: { dev: { command: ["pnpm", "dev"], workingDirectory: ".", host: "127.0.0.1", preferredPort: 3000, entryRoute: "/", editorAdapter: "react-rewrite" } },
  }, null, 2)}\n`);
}

async function serveProductionRenderer(t: test.TestContext): Promise<string> {
  const distRoot = path.resolve("dist");
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const relative = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
      const filePath = path.resolve(distRoot, relative);
      if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${path.sep}`)) throw new Error("outside dist");
      const body = await readFile(filePath);
      const extension = path.extname(filePath);
      response.setHeader("content-type", extension === ".js" ? "text/javascript" : extension === ".css" ? "text/css" : "text/html");
      response.end(body);
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Renderer server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

test("real Electron exposes the narrow bridge and handles cancelled and selected directories", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-electron-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const fixtureMain = await buildFixtureMain(temporary);
  const projectPath = path.join(temporary, "project");
  await writeProject(projectPath, "electron-fixture", "Electron fixture");
  const require = createRequire(import.meta.url);
  const executablePath = require("electron") as string;
  const application = await electron.launch({
    executablePath,
    args: [fixtureMain],
    env: {
      ...process.env,
      LARGER_ELECTRON_TEST_USER_DATA: path.join(temporary, "user-data"),
      LARGER_ELECTRON_TEST_PRELOAD: path.resolve(".larger/electron/preload.cjs"),
      LARGER_ELECTRON_TEST_PROJECT: projectPath,
    },
  });
  t.after(() => application.close());
  const page = await application.firstWindow();
  const boundary = await page.evaluate(() => ({
    projects: Object.keys(window.larger?.projects ?? {}).sort(),
    hasProcess: "process" in window,
    hasRequire: "require" in window,
    hasIpcRenderer: "ipcRenderer" in window,
  }));
  assert.equal(boundary.hasProcess, false);
  assert.equal(boundary.hasRequire, false);
  assert.equal(boundary.hasIpcRenderer, false);
  assert.deepEqual(boundary.projects, [
    "close", "dismissPending", "getSnapshot", "initialize", "onSnapshot", "openRecent", "pickAndOpen",
    "prepareWorkspace", "refresh", "removeRecent", "setTrust", "updateManifest", "updatePersonalState",
  ]);
  const result = await page.evaluate(async () => {
    const before = await window.larger!.projects.getSnapshot();
    const cancelled = await window.larger!.projects.pickAndOpen();
    const after = await window.larger!.projects.getSnapshot();
    return { before, cancelled, after };
  });
  assert.equal(result.cancelled.status, "cancelled");
  assert.deepEqual(result.after, result.before);
  const selected = await page.evaluate(() => window.larger!.projects.pickAndOpen());
  assert.equal(selected.status, "completed");
  assert.equal(selected.snapshot.active?.manifest.name, "Electron fixture");
});

test("production renderer switches through pending setup and restores personal UI state after relaunch", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-renderer-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const fixtureMain = await buildFixtureMain(temporary);
  const rendererUrl = await serveProductionRenderer(t);
  const userData = path.join(temporary, "user-data");
  const firstPath = path.join(temporary, "first");
  const pendingPath = path.join(temporary, "pending");
  await writeProject(firstPath, "renderer-first", "Renderer first");
  await writeProject(pendingPath, "unused", "Pending", false);
  const require = createRequire(import.meta.url);
  const executablePath = require("electron") as string;
  const launch = () => electron.launch({
    executablePath,
    args: [fixtureMain],
    env: {
      ...process.env,
      LARGER_ELECTRON_TEST_USER_DATA: userData,
      LARGER_ELECTRON_TEST_PRELOAD: path.resolve(".larger/electron/preload.cjs"),
      LARGER_ELECTRON_TEST_PROJECTS: JSON.stringify([firstPath, pendingPath]),
      LARGER_ELECTRON_TEST_RENDERER_URL: rendererUrl,
      LARGER_ELECTRON_TEST_CANCEL_FIRST: "false",
    },
  });

  const firstApplication = await launch();
  t.after(() => firstApplication.close());
  const firstPage = await firstApplication.firstWindow();
  await firstPage.getByRole("heading", { name: "Larger" }).waitFor({ timeout: 5_000 });
  await firstPage.getByRole("button", { name: "Open project" }).click();
  await firstPage.getByText("Renderer first").first().waitFor({ timeout: 5_000 });
  await firstPage.getByRole("button", { name: "Project settings" }).click();
  const settingsDialog = firstPage.getByRole("dialog");
  await settingsDialog.getByLabel("Name").fill("Draft settings name");
  await settingsDialog.getByLabel("Entry route").fill("missing-leading-slash");
  await settingsDialog.getByRole("button", { name: "Save settings" }).click();
  await settingsDialog.getByText("/runtimeProfiles/dev/entryRoute", { exact: true }).waitFor({ timeout: 5_000 });
  assert.equal(await settingsDialog.getByLabel("Name").inputValue(), "Draft settings name");
  assert.equal(await settingsDialog.getByLabel("Entry route").inputValue(), "missing-leading-slash");
  await settingsDialog.getByRole("button", { name: "Cancel" }).click();
  await firstPage.getByRole("button", { name: "Assets" }).click();
  await firstPage.getByText("Project assets will be indexed without moving them from source.").waitFor({ timeout: 5_000 });
  const pendingResult = await firstPage.evaluate(() => window.larger!.projects.pickAndOpen());
  assert.equal(pendingResult.status, "completed");
  assert.equal(pendingResult.snapshot.pending?.reason, "needs-initialization");
  await firstPage.getByText("Set up this project", { exact: true }).waitFor({ timeout: 5_000 });
  await firstPage.getByText("Detected project").waitFor({ timeout: 5_000 });
  await firstPage.getByLabel("Name").fill("Draft pending name");
  await firstPage.getByLabel("Entry route").fill("missing-leading-slash");
  await firstPage.getByRole("button", { name: "Initialize" }).click();
  await firstPage.getByText("/runtimeProfiles/dev/entryRoute", { exact: true }).waitFor({ timeout: 5_000 });
  assert.equal(await firstPage.getByLabel("Name").inputValue(), "Draft pending name");
  assert.equal(await firstPage.getByLabel("Entry route").inputValue(), "missing-leading-slash");
  await firstPage.getByRole("button", { name: "Cancel" }).click();
  await firstPage.getByText("Project assets will be indexed without moving them from source.").waitFor({ timeout: 5_000 });
  await firstApplication.close();

  const restoredApplication = await launch();
  t.after(() => restoredApplication.close());
  const restoredPage = await restoredApplication.firstWindow();
  await restoredPage.getByText("Renderer first").first().waitFor({ timeout: 5_000 });
  await restoredPage.getByText("Project assets will be indexed without moving them from source.").waitFor({ timeout: 5_000 });
});
