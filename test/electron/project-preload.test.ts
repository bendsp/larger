import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { build } from "esbuild";
import { _electron as electron } from "playwright-core";
import { RuntimeWorkspaceProvider } from "../../electron/runtime-workspaces/provider.js";
import {
  RUNTIME_FIXTURE_SOURCE,
  writeRuntimeFrameworkProject,
} from "../fixtures/runtime-framework/project-fixture.mjs";

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
    schemaVersion: 2,
    projectId,
    name,
    defaultRuntimeProfile: "dev",
    runtimeProfiles: { dev: {
      command: ["pnpm", "dev"],
      workingDirectory: ".",
      dependencyRoot: ".",
      host: "127.0.0.1",
      preferredPort: 3000,
      readiness: { path: "/", timeoutMs: 60_000 },
      entryRoute: "/",
      environment: { literals: {}, inherit: ["PATH"], secrets: {} },
      runtimeAdapter: "command",
      editorAdapter: "react-rewrite",
    } },
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

describe("production Electron integration", { concurrency: false }, () => {
test("real Electron exposes the narrow bridge and handles cancelled and selected directories", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-electron-test-"));
  t.after(() => removeTestTree(temporary));
  const fixtureMain = await buildFixtureMain(temporary);
  const rendererUrl = await serveProductionRenderer(t);
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
      LARGER_ELECTRON_TEST_RENDERER_URL: rendererUrl,
    },
  });
  t.after(() => application.close());
  const page = await application.firstWindow();
  await page.waitForFunction(() => (
    typeof window.larger?.application?.getSnapshot === "function"
    && typeof window.larger?.projects?.getSnapshot === "function"
  ));
  const boundary = await page.evaluate(() => ({
    namespaces: Object.fromEntries(Object.entries(window.larger!).map(([name, bridge]) => [
      name,
      Object.keys(bridge).sort(),
    ])),
    hasLegacyCanvas: "largerCanvas" in window,
    hasProcess: "process" in window,
    hasRequire: "require" in window,
    hasIpcRenderer: "ipcRenderer" in window,
  }));
  assert.equal(boundary.hasProcess, false);
  assert.equal(boundary.hasRequire, false);
  assert.equal(boundary.hasIpcRenderer, false);
  assert.equal(boundary.hasLegacyCanvas, false);
  assert.deepEqual(boundary.namespaces, {
    application: ["getSnapshot", "onSnapshot", "quit", "retry"],
    projects: [
      "close", "dismissPending", "getSnapshot", "initialize", "onSnapshot", "openRecent",
      "pickAndOpen", "prepareWorkspace", "refresh", "removeRecent", "setTrust",
      "updateManifest", "updatePersonalState",
    ],
    changes: [
      "commitApply", "discard", "getSnapshot", "onSnapshot", "prepareApply", "recover",
      "scan", "updateSelection",
    ],
    runtime: ["attach", "cancel", "detach", "discover", "getSnapshot", "onSnapshot", "restart", "start", "stop"],
    canvas: ["focus", "hide", "load", "navigate", "onFocusReturn", "onNavigation", "setBounds", "show"],
  });
  const result = await page.evaluate(async () => {
    const desktop = await window.larger!.application.getSnapshot();
    const before = await window.larger!.projects.getSnapshot();
    const cancelled = await window.larger!.projects.pickAndOpen();
    const after = await window.larger!.projects.getSnapshot();
    return { desktop, before, cancelled, after };
  });
  assert.equal(result.desktop.protocolVersion, 1);
  assert.equal(result.desktop.phase, "ready");
  assert.equal(result.cancelled.status, "cancelled");
  assert.deepEqual(result.after, result.before);
  const selected = await page.evaluate(() => window.larger!.projects.pickAndOpen());
  assert.equal(selected.status, "completed");
  assert.equal(selected.snapshot.active?.manifest.name, "Electron fixture");
});

test("production renderer recovers an unavailable desktop through the typed application bridge", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-lifecycle-test-"));
  t.after(() => removeTestTree(temporary));
  const fixtureMain = await buildFixtureMain(temporary);
  const rendererUrl = await serveProductionRenderer(t);
  const projectPath = path.join(temporary, "project");
  await writeProject(projectPath, "lifecycle-fixture", "Lifecycle fixture");
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
      LARGER_ELECTRON_TEST_RENDERER_URL: rendererUrl,
      LARGER_ELECTRON_TEST_SHOW: "true",
      LARGER_ELECTRON_TEST_APPLICATION_PHASE: "unavailable",
      LARGER_ELECTRON_TEST_RECOVERY_DELAY_MS: "300",
    },
  });
  t.after(() => closeElectronApplication(application));
  const page = await application.firstWindow();

  await page.getByRole("heading", { name: "Larger could not start" }).waitFor({ timeout: 5_000 });
  assert.match(await page.locator("body").innerText(), /The desktop services could not be started\./);
  assert.doesNotMatch(await page.locator("body").innerText(), /test desktop service failed safely/i);
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("heading", { name: "Restoring your workspace" }).waitFor();
  await page.getByRole("heading", { name: "Larger" }).waitFor({ timeout: 5_000 });
  assert.equal(await page.getByTestId("application-lifecycle").count(), 0);
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
      LARGER_ELECTRON_TEST_SHOW: "true",
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

test("production renderer owns managed runtime lifecycle and keeps attached previews external", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("Managed process-tree ownership is intentionally gated to Darwin");
    return;
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-runtime-renderer-test-"));
  const applications: Array<Awaited<ReturnType<typeof electron.launch>>> = [];
  t.after(async () => {
    for (const application of applications) await closeElectronApplication(application);
    await removeTestTree(temporary);
  });
  const fixtureMain = await buildFixtureMain(temporary);
  const rendererUrl = await serveProductionRenderer(t);
  const userData = path.join(temporary, "user-data");
  const projectPath = path.join(temporary, "project");
  const secondProjectPath = path.join(temporary, "second-project");

  const occupiedServer = createServer((_request, response) => response.end("external preview"));
  await new Promise<void>((resolve, reject) => {
    occupiedServer.once("error", reject);
    occupiedServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    occupiedServer.closeAllConnections();
    return new Promise<void>((resolve) => occupiedServer.close(() => resolve()));
  });
  const occupiedAddress = occupiedServer.address();
  assert.ok(occupiedAddress && typeof occupiedAddress !== "string");
  const preferredPort = occupiedAddress.port;
  await writeRuntimeFrameworkProject({
    projectPath,
    projectId: "renderer-runtime",
    name: "Renderer runtime",
    preferredPort,
  });
  await writeProject(secondProjectPath, "renderer-runtime-second", "Second runtime project");

  const require = createRequire(import.meta.url);
  const executablePath = require("electron") as string;
  const reactRewriteCliPath = path.join(
    path.dirname(require.resolve("react-rewrite-cli/package.json")),
    "bin",
    "react-rewrite.js",
  );
  const launch = () => electron.launch({
    executablePath,
    args: [fixtureMain],
    env: {
      ...process.env,
      LARGER_ELECTRON_TEST_USER_DATA: userData,
      LARGER_ELECTRON_TEST_PRELOAD: path.resolve(".larger/electron/preload.cjs"),
      LARGER_ELECTRON_TEST_PROJECTS: JSON.stringify([projectPath, secondProjectPath, projectPath]),
      LARGER_ELECTRON_TEST_RENDERER_URL: rendererUrl,
      LARGER_ELECTRON_TEST_CANCEL_FIRST: "false",
      LARGER_APPROVED_SECRET: "approved-production-secret",
      LARGER_UNAPPROVED_SECRET: "must-not-reach-child",
      LARGER_ELECTRON_TEST_SHOW: "true",
      LARGER_ELECTRON_TEST_REACT_REWRITE_CLI: reactRewriteCliPath,
    },
  });

  const firstApplication = await launch();
  applications.push(firstApplication);
  const firstPage = await firstApplication.firstWindow();
  await firstPage.getByRole("heading", { name: "Larger" }).waitFor({ timeout: 5_000 });
  await firstPage.getByRole("button", { name: "Open project" }).click();
  await firstPage.getByText("Renderer runtime").first().waitFor({ timeout: 5_000 });
  await firstPage.getByRole("button", { name: "Review trust" }).click();
  await firstPage.getByRole("button", { name: "Trust project" }).click();
  await firstPage.getByRole("button", { name: "Servers", exact: true }).click();
  await firstPage.getByRole("heading", { name: "Runtime workspace" }).waitFor({ timeout: 5_000 });
  await firstPage.getByRole("button", { name: "Start", exact: true }).click();
  await firstPage.getByRole("button", { name: "Cancel", exact: true }).waitFor({ timeout: 10_000 });
  await firstPage.getByRole("button", { name: "Cancel", exact: true }).click();
  await firstPage.getByRole("button", { name: "Start", exact: true }).waitFor({ timeout: 15_000 });
  await firstPage.getByRole("button", { name: "Start", exact: true }).click();
  try {
    await firstPage.getByText("Managed server ready", { exact: true }).first().waitFor({ timeout: 120_000 });
  } catch (cause) {
    const diagnostic = await firstPage.evaluate(async () => {
      const project = await window.larger!.projects.getSnapshot();
      return project.active
        ? window.larger!.runtime.getSnapshot(project.active.generation)
        : { project };
    });
    throw new Error(`Managed Vite fixture did not become ready: ${JSON.stringify(diagnostic)}`, { cause });
  }
  await firstPage.getByText("Preferred port was occupied", { exact: true }).waitFor({ timeout: 5_000 });

  const firstSnapshot = await firstPage.evaluate(async () => {
    const project = await window.larger!.projects.getSnapshot();
    assertProject(project.active);
    return window.larger!.runtime.getSnapshot(project.active.generation);

    function assertProject(active: typeof project.active): asserts active is NonNullable<typeof active> {
      if (!active) throw new Error("Expected an active project");
    }
  });
  assert.equal(firstSnapshot.session?.mode, "managed");
  assert.notEqual(firstSnapshot.session?.endpoint.portAllocation?.actual, preferredPort);
  const firstLogs = firstSnapshot.logWindow.entries.map((entry) => entry.message).join("\n");
  assert.match(firstLogs, /approved:\[REDACTED\]/);
  assert.match(firstLogs, /unapproved:missing/);
  assert.doesNotMatch(firstLogs, /approved-production-secret|must-not-reach-child/);
  await firstPage.getByRole("button", { name: "Copy logs", exact: true }).click();
  await firstPage.getByRole("button", { name: "Copied", exact: true }).waitFor({ timeout: 5_000 });
  const copiedLogs = await firstApplication.evaluate(({ clipboard }) => clipboard.readText());
  assert.match(copiedLogs, /approved:\[REDACTED\]/);
  assert.doesNotMatch(copiedLogs, /approved-production-secret|must-not-reach-child/);
  assert.equal((await fetch(firstSnapshot.session!.endpoint.displayUrl)).status, 200);
  assert.equal(
    await (await fetch(new URL("/draft.txt", firstSnapshot.session!.endpoint.displayUrl))).text(),
    "intentional untracked fixture state\n",
  );
  assert.equal(await readFile(path.join(projectPath, "draft.txt"), "utf8"), "intentional untracked fixture state\n");
  const screenshotPath = process.env.LARGER_RUNTIME_E2E_SCREENSHOT;
  if (screenshotPath) await firstPage.screenshot({ path: screenshotPath, fullPage: true });

  await firstPage.getByRole("button", { name: "Open canvas", exact: true }).click();
  await firstPage.getByLabel("Canvas route").waitFor({ timeout: 5_000 });
  const canvasDeadline = Date.now() + 10_000;
  let canvasState: { url: string; heading: string | null } | null = null;
  while (Date.now() < canvasDeadline && canvasState?.heading !== "Managed Vite fixture") {
    canvasState = await firstApplication.evaluate(async ({ BrowserWindow, webContents }, expectedUrl) => {
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (!mainWindow) return null;
      const canvas = webContents.getAllWebContents().find((contents) => (
        contents.id !== mainWindow.webContents.id && contents.getURL() === expectedUrl
      ));
      if (!canvas) return null;
      return {
        url: canvas.getURL(),
        heading: await canvas.executeJavaScript('document.querySelector("h1")?.textContent ?? null'),
      };
    }, firstSnapshot.session!.endpoint.displayUrl);
    if (canvasState?.heading !== "Managed Vite fixture") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.equal(canvasState?.url, firstSnapshot.session!.endpoint.displayUrl);
  assert.equal(canvasState?.heading, "Managed Vite fixture");
  await firstPage.getByRole("button", { name: "Focus preview", exact: true }).click();
  const focusDeadline = Date.now() + 5_000;
  let canvasFocused = false;
  while (!canvasFocused && Date.now() < focusDeadline) {
    canvasFocused = await firstApplication.evaluate(async ({ BrowserWindow, webContents }, expectedUrl) => {
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (!mainWindow) return false;
      const canvas = webContents.getAllWebContents().find((contents) => (
        contents.id !== mainWindow.webContents.id && contents.getURL() === expectedUrl
      ));
      return canvas ? await canvas.executeJavaScript("document.hasFocus()") as boolean : false;
    }, firstSnapshot.session!.endpoint.displayUrl);
    if (!canvasFocused) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(canvasFocused, true);
  await firstApplication.evaluate(({ BrowserWindow, webContents }, expectedUrl) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) throw new Error("Expected an Electron window");
    const canvas = webContents.getAllWebContents().find((contents) => (
      contents.id !== mainWindow.webContents.id && contents.getURL() === expectedUrl
    ));
    if (!canvas) throw new Error("Expected a canvas webContents");
    canvas.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  }, firstSnapshot.session!.endpoint.displayUrl);
  await firstPage.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Canvas route");

  await firstApplication.evaluate(async ({ BrowserWindow, webContents }, expectedUrl) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    const canvas = webContents.getAllWebContents().find((contents) => (
      contents.id !== mainWindow?.webContents.id && contents.getURL() === expectedUrl
    ));
    if (!canvas) throw new Error("Expected a canvas webContents");
    await canvas.executeJavaScript("document.body.dataset.largerState = 'preserved'");
  }, firstSnapshot.session!.endpoint.displayUrl);

  await firstPage.getByRole("button", { name: "Project settings" }).click();
  await firstPage.getByRole("heading", { name: "Project settings" }).waitFor({ timeout: 5_000 });
  assert.equal(await firstApplication.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return window?.contentView.children.length ?? -1;
  }), 0);
  await firstPage.getByRole("button", { name: "Cancel", exact: true }).click();
  await firstPage.getByRole("heading", { name: "Project settings" }).waitFor({ state: "detached" });
  await firstPage.waitForFunction(() => document.querySelector('[aria-label="Canvas route"]') !== null);
  assert.equal(await firstApplication.evaluate(async ({ BrowserWindow, webContents }, expectedUrl) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    const canvas = webContents.getAllWebContents().find((contents) => (
      contents.id !== mainWindow?.webContents.id && contents.getURL() === expectedUrl
    ));
    return canvas ? await canvas.executeJavaScript("document.body.dataset.largerState") : null;
  }, firstSnapshot.session!.endpoint.displayUrl), "preserved");
  await firstApplication.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(700, 700);
  });
  await firstPage.getByRole("button", { name: "Toggle Sidebar" }).click();
  await firstPage.waitForFunction(() => document.querySelector('[data-mobile="true"]') !== null);
  assert.equal(await firstApplication.evaluate(({ BrowserWindow }) => (
    BrowserWindow.getAllWindows()[0]?.contentView.children.length ?? -1
  )), 0);
  await firstPage.keyboard.press("Escape");
  await firstApplication.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 800);
  });
  const canvasScreenshotPath = process.env.LARGER_CANVAS_E2E_SCREENSHOT;
  if (canvasScreenshotPath) {
    const png = await firstApplication.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Expected an Electron window");
      return (await window.capturePage()).toPNG().toString("base64");
    });
    await writeFile(canvasScreenshotPath, Buffer.from(png, "base64"));
  }
  await firstPage.getByRole("button", { name: "Servers", exact: true }).click();
  await firstPage.getByRole("heading", { name: "Runtime workspace" }).waitFor({ timeout: 5_000 });

  await firstPage.getByRole("button", { name: "Restart", exact: true }).click();
  const restartDeadline = Date.now() + 15_000;
  let restartedSnapshot = await firstPage.evaluate(async () => {
    const project = await window.larger!.projects.getSnapshot();
    if (!project.active) throw new Error("Expected an active project");
    return window.larger!.runtime.getSnapshot(project.active.generation);
  });
  while (
    Date.now() < restartDeadline
    && !(
      restartedSnapshot.phase === "ready-managed"
      && restartedSnapshot.session?.mode === "managed"
      && restartedSnapshot.session.id !== firstSnapshot.session!.id
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    restartedSnapshot = await firstPage.evaluate(async () => {
      const project = await window.larger!.projects.getSnapshot();
      if (!project.active) throw new Error("Expected an active project");
      return window.larger!.runtime.getSnapshot(project.active.generation);
    });
  }
  assert.equal(restartedSnapshot.session?.mode, "managed");
  assert.notEqual(restartedSnapshot.session?.id, firstSnapshot.session?.id);
  assert.equal(restartedSnapshot.session?.baselineIdentity, firstSnapshot.session?.baselineIdentity);
  await firstPage.getByRole("button", { name: "Stop", exact: true }).click();
  await firstPage.getByRole("button", { name: "Start", exact: true }).waitFor({ timeout: 10_000 });
  const nextResult = await firstPage.evaluate(async () => {
    const project = await window.larger!.projects.getSnapshot();
    if (!project.active) throw new Error("Expected an active project");
    const runtime = await window.larger!.runtime.getSnapshot(project.active.generation);
    return window.larger!.runtime.start(project.active.generation, "next", runtime.revision);
  });
  assert.equal(
    nextResult.snapshot.phase,
    "ready-managed",
    JSON.stringify({ problem: nextResult.snapshot.problem, logs: nextResult.snapshot.logWindow }, null, 2),
  );
  assert.equal(nextResult.snapshot.session?.profileName, "next");
  assert.match(
    await (await fetch(nextResult.snapshot.session!.endpoint.displayUrl)).text(),
    /Managed Next fixture/,
  );
  await firstPage.evaluate(async (sessionId) => {
    const project = await window.larger!.projects.getSnapshot();
    if (!project.active) throw new Error("Expected an active project");
    const runtime = await window.larger!.runtime.getSnapshot(project.active.generation);
    await window.larger!.runtime.stop(project.active.generation, sessionId, runtime.revision);
  }, nextResult.snapshot.session!.id);
  const rewriteResult = await firstPage.evaluate(async () => {
    const project = await window.larger!.projects.getSnapshot();
    if (!project.active) throw new Error("Expected an active project");
    const runtime = await window.larger!.runtime.getSnapshot(project.active.generation);
    return window.larger!.runtime.start(project.active.generation, "react-rewrite", runtime.revision);
  });
  assert.equal(
    rewriteResult.snapshot.phase,
    "ready-managed",
    JSON.stringify({ problem: rewriteResult.snapshot.problem, logs: rewriteResult.snapshot.logWindow }, null, 2),
  );
  assert.equal(rewriteResult.snapshot.session?.surface.editorAdapter, "react-rewrite");
  assert.equal(rewriteResult.snapshot.session?.surface.writable, true);
  await firstPage.getByRole("button", { name: "Canvas", exact: true }).click();
  await firstPage.getByLabel("Canvas route").waitFor({ timeout: 10_000 });

  const rewriteCanvasDeadline = Date.now() + 15_000;
  let rewriteCanvasId: number | null = null;
  while (rewriteCanvasId === null && Date.now() < rewriteCanvasDeadline) {
    rewriteCanvasId = await firstApplication.evaluate(async ({ BrowserWindow, webContents }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0];
      for (const contents of webContents.getAllWebContents()) {
        if (contents.id === mainWindow?.webContents.id || contents.isDestroyed()) continue;
        try {
          if (await contents.executeJavaScript('document.querySelector("h1")?.textContent === "Managed Vite fixture"')) {
            return contents.id;
          }
        } catch {
          // A renderer may disappear while the native Canvas is switching surfaces.
        }
      }
      return null;
    });
    if (rewriteCanvasId === null) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(rewriteCanvasId !== null, "React Rewrite Canvas did not render the managed React fixture");
  await firstApplication.evaluate(async ({ webContents }, canvasId) => {
    const canvas = webContents.fromId(canvasId);
    if (!canvas) throw new Error("Expected a React Rewrite canvas webContents");
    await canvas.executeJavaScript(`(async () => {
      const heading = document.querySelector('h1');
      if (!heading) throw new Error('Missing editable heading');
      const rect = heading.getBoundingClientRect();
      const pointer = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      };
      heading.dispatchEvent(new MouseEvent('mousedown', pointer));
      heading.dispatchEvent(new MouseEvent('mouseup', pointer));
      const sourceDeadline = Date.now() + 5_000;
      let sourcePath = '';
      while (!sourcePath.includes('src/App.jsx') && Date.now() < sourceDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        sourcePath = document.querySelector('#react-rewrite-root')?.shadowRoot
          ?.querySelector('.component-detail .path')?.textContent ?? '';
      }
      if (!sourcePath.includes('src/App.jsx')) {
        throw new Error('React Rewrite did not resolve the selected heading to src/App.jsx');
      }
      heading.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (heading.getAttribute('contenteditable') !== 'true') throw new Error('React Rewrite did not enter text editing mode');
      heading.focus();
      heading.textContent = 'Edited through Larger';
      heading.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
      heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      heading.blur();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const confirm = document.querySelector('#react-rewrite-root')?.shadowRoot?.querySelector('.generate-btn');
      if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
        throw new Error('React Rewrite did not make the visual edit confirmable');
      }
      confirm.click();
    })()`);
  }, rewriteCanvasId);

  const reviewDeadline = Date.now() + 15_000;
  let detectedChange: Awaited<ReturnType<NonNullable<typeof window.larger>["changes"]["scan"]>> | null = null;
  while (Date.now() < reviewDeadline) {
    try {
      detectedChange = await firstPage.evaluate(async () => {
        const project = await window.larger!.projects.getSnapshot();
        if (!project.active) throw new Error("Expected an active project");
        return window.larger!.changes.scan(project.active.generation);
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Runtime tree changed during scan")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (detectedChange.snapshot.changeSet?.files.some((file) => file.path === "src/App.jsx")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const rewriteChangeSet = detectedChange?.snapshot.changeSet;
  assert.ok(rewriteChangeSet, "React Rewrite edit did not produce a ChangeSet");
  const rewriteFile = rewriteChangeSet.files.find((file) => file.path === "src/App.jsx");
  assert.ok(rewriteFile && rewriteFile.kind === "text", "React Rewrite edit was not captured as text");
  assert.equal(await readFile(path.join(projectPath, "src", "App.jsx"), "utf8"), RUNTIME_FIXTURE_SOURCE);
  const selectedChange = await firstPage.evaluate(async ({ changeSetId, revision, fileId, hunkIds }) => {
    const project = await window.larger!.projects.getSnapshot();
    if (!project.active) throw new Error("Expected an active project");
    return window.larger!.changes.updateSelection(project.active.generation, changeSetId, revision, {
      files: [{ fileId, includeFile: true, hunkIds }],
    });
  }, {
    changeSetId: rewriteChangeSet.id,
    revision: rewriteChangeSet.revision,
    fileId: rewriteFile.id,
    hunkIds: rewriteFile.hunks.map((hunk) => hunk.id),
  });
  const selectedSnapshot = selectedChange.snapshot.changeSet;
  assert.ok(selectedSnapshot);
  const preparedChange = await firstPage.evaluate(async ({ changeSetId, revision }) => {
    const project = await window.larger!.projects.getSnapshot();
    if (!project.active) throw new Error("Expected an active project");
    return window.larger!.changes.prepareApply(project.active.generation, changeSetId, revision);
  }, { changeSetId: selectedSnapshot.id, revision: selectedSnapshot.revision });
  assert.equal(preparedChange.status, "prepared");
  assert.ok(preparedChange.transactionId && preparedChange.planDigest);
  await firstPage.evaluate(async ({ transactionId, planDigest }) => {
    const project = await window.larger!.projects.getSnapshot();
    if (!project.active) throw new Error("Expected an active project");
    return window.larger!.changes.commitApply(project.active.generation, transactionId, planDigest);
  }, { transactionId: preparedChange.transactionId, planDigest: preparedChange.planDigest });
  assert.match(await readFile(path.join(projectPath, "src", "App.jsx"), "utf8"), /Edited through Larger/);
  await firstPage.evaluate(async (sessionId) => {
    const project = await window.larger!.projects.getSnapshot();
    if (!project.active) throw new Error("Expected an active project");
    const runtime = await window.larger!.runtime.getSnapshot(project.active.generation);
    await window.larger!.runtime.stop(project.active.generation, sessionId, runtime.revision);
  }, rewriteResult.snapshot.session!.id);
  const switchRuntime = await firstPage.evaluate(async () => {
    const project = await window.larger!.projects.getSnapshot();
    if (!project.active) throw new Error("Expected an active project");
    const runtime = await window.larger!.runtime.getSnapshot(project.active.generation);
    return window.larger!.runtime.start(project.active.generation, "vite", runtime.revision);
  });
  assert.equal(switchRuntime.snapshot.phase, "ready-managed");
  const switchedEndpoint = switchRuntime.snapshot.session!.endpoint.displayUrl;
  const switchedProject = await firstPage.evaluate(() => window.larger!.projects.pickAndOpen());
  assert.equal(switchedProject.snapshot.active?.identity.projectId, "renderer-runtime-second");
  await assert.rejects(() => fetch(switchedEndpoint));
  const restoredProject = await firstPage.evaluate(() => window.larger!.projects.pickAndOpen());
  assert.equal(restoredProject.snapshot.active?.identity.projectId, "renderer-runtime");
  await closeElectronApplication(firstApplication);

  const restoredApplication = await launch();
  applications.push(restoredApplication);
  const restoredPage = await restoredApplication.firstWindow();
  await restoredPage.getByText("Renderer runtime").first().waitFor({ timeout: 10_000 });
  await restoredPage.getByRole("button", { name: "Servers", exact: true }).click();
  await restoredPage.getByRole("button", { name: "Start", exact: true }).click();
  await restoredPage.getByText("Managed server ready", { exact: true }).first().waitFor({ timeout: 15_000 });
  const restoredSnapshot = await restoredPage.evaluate(async () => {
    const project = await window.larger!.projects.getSnapshot();
    if (!project.active) throw new Error("Expected an active project");
    return window.larger!.runtime.getSnapshot(project.active.generation);
  });
  assert.equal(restoredSnapshot.session?.mode, "managed");
  assert.equal(restoredSnapshot.session?.baselineIdentity, firstSnapshot.session?.baselineIdentity);
  assert.equal(restoredSnapshot.session?.runtimeId, firstSnapshot.session?.runtimeId);
  const crashedEndpoint = restoredSnapshot.session!.endpoint.displayUrl;
  const crashedApplicationClosed = restoredApplication.waitForEvent("close");
  restoredApplication.process().kill("SIGKILL");
  await crashedApplicationClosed;
  const cleanupDeadline = Date.now() + 10_000;
  let targetStopped = false;
  while (Date.now() < cleanupDeadline && !targetStopped) {
    try {
      await fetch(crashedEndpoint);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      targetStopped = true;
    }
  }
  assert.equal(targetStopped, true, "Managed target survived an abrupt Larger process exit");

  const recoveredApplication = await launch();
  applications.push(recoveredApplication);
  const recoveredPage = await recoveredApplication.firstWindow();
  await recoveredPage.getByText("Renderer runtime").first().waitFor({ timeout: 10_000 });
  await recoveredPage.getByRole("button", { name: "Servers", exact: true }).click();
  await recoveredPage.getByRole("button", { name: "Start", exact: true }).waitFor({ timeout: 10_000 });
  await recoveredPage.getByRole("tab", { name: "Attach preview" }).click();
  await recoveredPage.getByLabel("Local server URL").fill(`http://127.0.0.1:${preferredPort}`);
  await recoveredPage.getByRole("button", { name: "Attach", exact: true }).click();
  await recoveredPage.getByText("External process — never stopped by Larger", { exact: true }).waitFor({ timeout: 10_000 });
  await recoveredPage.getByRole("button", { name: "Detach", exact: true }).click();
  assert.equal((await fetch(`http://127.0.0.1:${preferredPort}`)).status, 200);
  await closeElectronApplication(recoveredApplication);
});
});
