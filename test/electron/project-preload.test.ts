import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { _electron as electron } from "playwright-core";
import { RuntimeWorkspaceProvider } from "../../electron/runtime-workspaces/provider.js";

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

async function closeElectronApplication(application: Awaited<ReturnType<typeof electron.launch>>): Promise<void> {
  let processHandle: ReturnType<typeof application.process>;
  try {
    processHandle = application.process();
  } catch {
    return;
  }
  if (processHandle.exitCode !== null || processHandle.killed) return;
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    application.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, 2_000);
      timeout.unref();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (processHandle.exitCode === null && !processHandle.killed) {
    try {
      processHandle.kill("SIGKILL");
    } catch {
      // The Electron process may exit between the state check and the fallback signal.
    }
  }
}

async function removeTestTree(root: string): Promise<void> {
  async function makeWritable(entryPath: string): Promise<void> {
    let entry;
    try {
      entry = await lstat(entryPath);
    } catch {
      return;
    }
    if (entry.isSymbolicLink()) return;
    if (!entry.isDirectory()) {
      await chmod(entryPath, 0o600);
      return;
    }
    await chmod(entryPath, 0o700);
    for (const child of await readdir(entryPath)) await makeWritable(path.join(entryPath, child));
  }

  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
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
  t.after(() => removeTestTree(temporary));
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
    changes: Object.keys(window.larger?.changes ?? {}).sort(),
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
  assert.deepEqual(boundary.changes, [
    "commitApply", "discard", "getSnapshot", "onSnapshot", "prepareApply", "recover", "scan", "updateSelection",
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
  t.after(() => removeTestTree(temporary));
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
  t.after(() => closeElectronApplication(firstApplication));
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
  await closeElectronApplication(firstApplication);

  const restoredApplication = await launch();
  t.after(() => closeElectronApplication(restoredApplication));
  const restoredPage = await restoredApplication.firstWindow();
  await restoredPage.getByText("Renderer first").first().waitFor({ timeout: 5_000 });
  await restoredPage.getByText("Project assets will be indexed without moving them from source.").waitFor({ timeout: 5_000 });
});

test("production renderer reviews one hunk and recovers the prepared plan after relaunch", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-changes-renderer-test-"));
  t.after(() => removeTestTree(temporary));
  const fixtureMain = await buildFixtureMain(temporary);
  const rendererUrl = await serveProductionRenderer(t);
  const userData = path.join(temporary, "user-data");
  const projectPath = path.join(temporary, "project");
  await writeProject(projectPath, "renderer-changes", "Renderer changes");
  await mkdir(path.join(projectPath, "src"));
  const baseline = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  await writeFile(path.join(projectPath, "src/app.txt"), baseline);
  await writeFile(path.join(projectPath, "src/unrelated.txt"), "clean\n");
  const require = createRequire(import.meta.url);
  const executablePath = require("electron") as string;
  const launch = () => electron.launch({
    executablePath,
    args: [fixtureMain],
    env: {
      ...process.env,
      LARGER_ELECTRON_TEST_USER_DATA: userData,
      LARGER_ELECTRON_TEST_PRELOAD: path.resolve(".larger/electron/preload.cjs"),
      LARGER_ELECTRON_TEST_PROJECT: projectPath,
      LARGER_ELECTRON_TEST_RENDERER_URL: rendererUrl,
      LARGER_ELECTRON_TEST_CANCEL_FIRST: "false",
    },
  });

  const firstApplication = await launch();
  t.after(() => closeElectronApplication(firstApplication));
  const firstPage = await firstApplication.firstWindow();
  await firstPage.getByRole("heading", { name: "Larger" }).waitFor({ timeout: 5_000 });
  await firstPage.getByRole("button", { name: "Open project" }).click();
  await firstPage.getByText("Renderer changes").first().waitFor({ timeout: 5_000 });
  await firstPage.getByRole("button", { name: "Review trust" }).click();
  await firstPage.getByRole("button", { name: "Trust project" }).click();
  await firstPage.getByText("Trusted", { exact: true }).waitFor({ timeout: 5_000 });
  await firstPage.getByRole("button", { name: "Changes", exact: true }).click({ timeout: 3_000 });
  await firstPage.getByRole("button", { name: "Prepare workspace" }).first().click({ timeout: 3_000 });
  await firstPage.getByRole("button", { name: "Scan again" }).waitFor({ timeout: 10_000 });

  const active = await firstPage.evaluate(() => window.larger!.projects.getSnapshot());
  assert.ok(active.active);
  const provider = new RuntimeWorkspaceProvider({
    userDataPath: userData,
    localInstanceKey: active.active.identity.instanceKey,
  });
  const workspace = await provider.current();
  assert.ok(workspace);
  const runtime = baseline
    .replace("line 1\n", "LINE ONE\n")
    .replace("line 14\n", "LINE FOURTEEN\n");
  await writeFile(path.join(workspace.runtimePath, "src/app.txt"), runtime);
  await firstPage.getByRole("button", { name: "Scan again" }).click({ timeout: 3_000 });
  await firstPage.getByRole("heading", { name: "Runtime change review" }).waitFor({ timeout: 10_000 });
  await firstPage.getByText("0 of 2 hunks included").waitFor({ timeout: 5_000 });
  await firstPage.getByRole("checkbox", { name: /Include hunk/ }).first().click({ timeout: 3_000 });
  await firstPage.getByText("1 of 2 hunks included").waitFor({ timeout: 5_000 });
  const dirtyUnrelated = Buffer.from("dirty unrelated\r\n", "utf8");
  await writeFile(path.join(projectPath, "src/unrelated.txt"), dirtyUnrelated);
  await firstPage.getByRole("button", { name: "Apply 1 hunk" }).click({ timeout: 3_000 });
  await firstPage.getByRole("heading", { name: "Apply selected changes to source?" }).waitFor({ timeout: 10_000 });
  await firstPage.getByRole("button", { name: "Cancel" }).click({ timeout: 3_000 });
  await firstPage.getByRole("heading", { name: "Apply selected changes to source?" }).waitFor({ state: "hidden", timeout: 10_000 });
  await firstPage.getByRole("button", { name: "Apply 1 hunk" }).click({ timeout: 3_000 });
  await firstPage.getByRole("heading", { name: "Apply selected changes to source?" }).waitFor({ timeout: 10_000 });
  const screenshotPath = process.env.LARGER_E2E_SCREENSHOT;
  if (screenshotPath) await firstPage.screenshot({ path: screenshotPath });
  await closeElectronApplication(firstApplication);

  const restoredApplication = await launch();
  t.after(() => closeElectronApplication(restoredApplication));
  const restoredPage = await restoredApplication.firstWindow();
  await restoredPage.getByText("Renderer changes").first().waitFor({ timeout: 10_000 });
  await restoredPage.getByRole("button", { name: "Changes", exact: true }).click({ timeout: 3_000 });
  await restoredPage.getByText("Source transaction needs attention").waitFor({ timeout: 10_000 });
  await restoredPage.getByRole("button", { name: "Roll forward safely" }).click({ timeout: 3_000 });
  await restoredPage.getByText("Selected changes applied").waitFor({ timeout: 10_000 });

  const expected = baseline.replace("line 1\n", "LINE ONE\n");
  const appliedSource = await readFile(path.join(projectPath, "src/app.txt"), "utf8");
  const unrelatedSource = await readFile(path.join(projectPath, "src/unrelated.txt"));
  assert.equal(appliedSource, expected);
  assert.deepEqual(unrelatedSource, dirtyUnrelated);
  await closeElectronApplication(restoredApplication);
});
