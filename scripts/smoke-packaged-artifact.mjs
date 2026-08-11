import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import {
  RUNTIME_FIXTURE_HEADING,
  RUNTIME_FIXTURE_SOURCE,
  writeRuntimeFrameworkProject,
} from "../test/fixtures/runtime-framework/project-fixture.mjs";
import { verifyPackagedArtifact } from "./verify-packaged-artifact.mjs";

const PROCESS_OUTPUT_LIMIT = 1024 * 1024;
const APPLICATION_TIMEOUT_MS = 180_000;

function run(executablePath, args, environment, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    const capture = (chunk) => {
      if (outputBytes >= PROCESS_OUTPUT_LIMIT) return;
      const remaining = PROCESS_OUTPUT_LIMIT - outputBytes;
      const bounded = chunk.subarray(0, remaining);
      output.push(bounded);
      outputBytes += bounded.byteLength;
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(cause);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const text = Buffer.concat(output).toString("utf8");
      if (timedOut) reject(new Error(`Packaged process timed out after ${timeoutMs}ms: ${text}`));
      else if (signal || code !== 0) reject(new Error(`Packaged process failed (${signal ?? code}): ${text}`));
      else resolve(text);
    });
  });
}

async function eventually(label, timeoutMs, read) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (cause) {
      lastError = cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`, lastError ? { cause: lastError } : undefined);
}

async function withTimeout(label, timeoutMs, operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function forceCloseApplication(application) {
  let applicationProcess;
  try {
    applicationProcess = application.process();
  } catch {
    return;
  }
  if (applicationProcess.exitCode !== null || applicationProcess.killed) return;
  let timeout;
  await Promise.race([
    application.close().catch(() => undefined),
    new Promise((resolve) => {
      timeout = setTimeout(resolve, 5_000);
      timeout.unref();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (applicationProcess.exitCode === null && !applicationProcess.killed) {
    try {
      applicationProcess.kill("SIGKILL");
    } catch {
      // The application may exit between the state check and fallback signal.
    }
  }
}

async function allocatePreferredPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "Temporary port server did not bind");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port - 10;
}

async function ownershipRecords(userData) {
  try {
    return await readdir(path.join(userData, "recovery", "process-ownership"));
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
}

async function endpointIsUnavailable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}

async function removeTestTree(root) {
  const temporaryRoot = await realpath(os.tmpdir());
  const canonicalRoot = await realpath(root).catch(() => path.resolve(root));
  if (
    path.dirname(canonicalRoot) !== temporaryRoot
    || !path.basename(canonicalRoot).startsWith("larger-packaged-smoke-")
  ) {
    throw new Error(`Refusing to remove unexpected packaged-smoke path: ${canonicalRoot}`);
  }

  async function makeWritable(entryPath) {
    let entry;
    try {
      entry = await lstat(entryPath);
    } catch (cause) {
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") return;
      throw cause;
    }
    if (entry.isSymbolicLink()) return;
    if (!entry.isDirectory()) {
      await chmod(entryPath, 0o600);
      return;
    }
    await chmod(entryPath, 0o700);
    for (const child of await readdir(entryPath)) await makeWritable(path.join(entryPath, child));
  }

  await makeWritable(canonicalRoot);
  await rm(canonicalRoot, { recursive: true, force: true });
}

const artifact = await verifyPackagedArtifact(process.argv[2]);
const virtualCliPath = path.join(artifact.archivePath, "node_modules", "react-rewrite-cli", "bin", "react-rewrite.js");
const launcher = "const {pathToFileURL}=require('node:url');import(pathToFileURL(process.argv[1]).href)";
const help = await run(artifact.executablePath, ["--eval", launcher, virtualCliPath, "--help"], { ELECTRON_RUN_AS_NODE: "1" });
assert.match(help, /react-rewrite/i, "Packaged React Rewrite CLI did not produce its help output");

const temporary = await mkdtemp(path.join(os.tmpdir(), "larger-packaged-smoke-"));
const canonicalTemporary = await realpath(temporary);
const userData = path.join(canonicalTemporary, "user-data");
const seedProject = path.join(canonicalTemporary, "seed-project");
const runtimeProject = path.join(canonicalTemporary, "runtime-project");
const preferredPort = await allocatePreferredPort();
await writeRuntimeFrameworkProject({
  projectPath: seedProject,
  projectId: "packaged-seed",
  name: "Packaged seed",
  preferredPort: preferredPort + 100,
});
await writeRuntimeFrameworkProject({
  projectPath: runtimeProject,
  projectId: "packaged-runtime",
  name: "Packaged runtime",
  preferredPort,
});

let application;
const applicationOutput = [];
let applicationOutputBytes = 0;
const captureApplicationOutput = (chunk) => {
  if (applicationOutputBytes >= PROCESS_OUTPUT_LIMIT) return;
  const bounded = chunk.subarray(0, PROCESS_OUTPUT_LIMIT - applicationOutputBytes);
  applicationOutput.push(bounded);
  applicationOutputBytes += bounded.byteLength;
};

try {
  application = await electron.launch({
    executablePath: artifact.executablePath,
    args: [`--user-data-dir=${userData}`, `--larger-open-project=${seedProject}`],
    env: { ...process.env },
    timeout: 30_000,
  });
  const applicationProcess = application.process();
  const applicationPid = applicationProcess.pid;
  applicationProcess.stdout?.on("data", captureApplicationOutput);
  applicationProcess.stderr?.on("data", captureApplicationOutput);

  let window;
  try {
    window = await application.firstWindow({ timeout: 30_000 });
  } catch (cause) {
    const output = Buffer.concat(applicationOutput).toString("utf8");
    throw new Error(`Packaged renderer did not open a window. Process output:\n${output}`, { cause });
  }
  await window.locator("#root").waitFor({ state: "attached", timeout: 30_000 });
  assert.match(window.url(), /^file:/, "Packaged renderer did not load from an embedded file URL");

  await eventually("the initial packaged project intent", 15_000, async () => {
    const activePath = await window.evaluate(async () => (await window.larger.projects.getSnapshot()).active?.identity.canonicalPath);
    return activePath === seedProject;
  });

  await run(
    artifact.executablePath,
    [`--user-data-dir=${userData}`, `--larger-open-project=${runtimeProject}`],
    {},
  );
  assert.equal(application.process().pid, applicationPid, "The first packaged app process was replaced");
  const singleInstanceState = await eventually("the second-instance project intent", 15_000, async () => {
    const snapshot = await window.evaluate(async () => window.larger.projects.getSnapshot());
    return snapshot.active?.identity.canonicalPath === runtimeProject ? snapshot : null;
  });
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  const idleRuntime = await window.evaluate(
    async (generation) => window.larger.runtime.getSnapshot(generation),
    singleInstanceState.active.generation,
  );
  assert.equal(idleRuntime.session, null, "A second-instance intent unexpectedly started a runtime");
  assert.deepEqual(await ownershipRecords(userData), [], "A second-instance intent created process ownership records");

  const trustedProject = await window.evaluate(async () => {
    const snapshot = await window.larger.projects.getSnapshot();
    if (!snapshot.active) throw new Error("Expected the routed packaged project to be active");
    return window.larger.projects.setTrust(snapshot.active.generation, "trusted");
  });
  assert.equal(trustedProject.snapshot.active?.trust, "trusted");
  const generation = trustedProject.snapshot.active.generation;

  const startResult = await withTimeout(
    "packaged managed runtime startup",
    APPLICATION_TIMEOUT_MS,
    window.evaluate(async (projectGeneration) => {
      const runtime = await window.larger.runtime.getSnapshot(projectGeneration);
      return window.larger.runtime.start(projectGeneration, "react-rewrite", runtime.revision);
    }, generation),
  );
  assert.equal(
    startResult.snapshot.phase,
    "ready-managed",
    JSON.stringify({ problem: startResult.snapshot.problem, logs: startResult.snapshot.logWindow }, null, 2),
  );
  const session = startResult.snapshot.session;
  assert.ok(session?.mode === "managed", "Packaged runtime did not produce a managed session");
  assert.equal(session.surface.editorAdapter, "react-rewrite");
  assert.equal(session.surface.writable, true);
  assert.equal((await fetch(session.endpoint.displayUrl)).status, 200);

  await window.getByRole("button", { name: "Canvas", exact: true }).click();
  await window.getByLabel("Canvas route").waitFor({ timeout: 10_000 });
  const canvasId = await eventually("the packaged React Rewrite canvas", 20_000, async () => application.evaluate(
    async ({ BrowserWindow, webContents }, heading) => {
      const mainWindow = BrowserWindow.getAllWindows()[0];
      for (const contents of webContents.getAllWebContents()) {
        if (contents.id === mainWindow?.webContents.id || contents.isDestroyed()) continue;
        try {
          if (await contents.executeJavaScript(`document.querySelector('h1')?.textContent === ${JSON.stringify(heading)}`)) {
            return contents.id;
          }
        } catch {
          // A renderer may disappear while the native Canvas switches surfaces.
        }
      }
      return null;
    },
    RUNTIME_FIXTURE_HEADING,
  ));

  const editedHeading = "Edited through Packaged Larger";
  await application.evaluate(async ({ webContents }, { canvasId: targetId, editedHeading: nextHeading }) => {
    const canvas = webContents.fromId(targetId);
    if (!canvas) throw new Error("Expected a packaged React Rewrite canvas webContents");
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
        throw new Error('React Rewrite did not resolve the packaged heading to src/App.jsx');
      }
      heading.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (heading.getAttribute('contenteditable') !== 'true') throw new Error('React Rewrite did not enter text editing mode');
      heading.focus();
      heading.textContent = ${JSON.stringify(nextHeading)};
      heading.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
      heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      heading.blur();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const confirm = document.querySelector('#react-rewrite-root')?.shadowRoot?.querySelector('.generate-btn');
      if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
        throw new Error('React Rewrite did not make the packaged visual edit confirmable');
      }
      confirm.click();
    })()`);
  }, { canvasId, editedHeading });

  const detectedChange = await eventually("the packaged React Rewrite ChangeSet", 20_000, async () => {
    try {
      const result = await window.evaluate(async (projectGeneration) => window.larger.changes.scan(projectGeneration), generation);
      return result.snapshot.changeSet?.files.some((file) => file.path === "src/App.jsx") ? result : null;
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("Runtime tree changed during scan")) return null;
      throw cause;
    }
  });
  const changeSet = detectedChange.snapshot.changeSet;
  assert.ok(changeSet, "Packaged React Rewrite edit did not produce a ChangeSet");
  const changedFile = changeSet.files.find((file) => file.path === "src/App.jsx");
  assert.ok(changedFile?.kind === "text", "Packaged React Rewrite edit was not captured as text");
  const sourcePath = path.join(runtimeProject, "src", "App.jsx");
  assert.equal(await readFile(sourcePath, "utf8"), RUNTIME_FIXTURE_SOURCE, "React Rewrite mutated the source before apply");

  const selected = await window.evaluate(async ({ projectGeneration, changeSetId, revision, fileId, hunkIds }) => (
    window.larger.changes.updateSelection(projectGeneration, changeSetId, revision, {
      files: [{ fileId, includeFile: true, hunkIds }],
    })
  ), {
    projectGeneration: generation,
    changeSetId: changeSet.id,
    revision: changeSet.revision,
    fileId: changedFile.id,
    hunkIds: changedFile.hunks.map((hunk) => hunk.id),
  });
  assert.ok(selected.snapshot.changeSet, "Selected packaged ChangeSet disappeared");
  const prepared = await window.evaluate(async ({ projectGeneration, changeSetId, revision }) => (
    window.larger.changes.prepareApply(projectGeneration, changeSetId, revision)
  ), {
    projectGeneration: generation,
    changeSetId: selected.snapshot.changeSet.id,
    revision: selected.snapshot.changeSet.revision,
  });
  assert.equal(prepared.status, "prepared");
  assert.ok(prepared.transactionId && prepared.planDigest, "Packaged apply did not produce an authorized transaction");
  await window.evaluate(async ({ projectGeneration, transactionId, planDigest }) => (
    window.larger.changes.commitApply(projectGeneration, transactionId, planDigest)
  ), { projectGeneration: generation, transactionId: prepared.transactionId, planDigest: prepared.planDigest });
  assert.match(await readFile(sourcePath, "utf8"), new RegExp(editedHeading), "Packaged apply did not update the source");

  const stopped = await window.evaluate(async ({ projectGeneration, sessionId }) => {
    const runtime = await window.larger.runtime.getSnapshot(projectGeneration);
    return window.larger.runtime.stop(projectGeneration, sessionId, runtime.revision);
  }, { projectGeneration: generation, sessionId: session.id });
  assert.equal(stopped.snapshot.session, null, "Explicit packaged runtime stop retained a session");
  await eventually("the packaged target endpoint to stop", 15_000, () => endpointIsUnavailable(session.endpoint.displayUrl));
  await eventually("packaged process ownership cleanup", 15_000, async () => (
    (await ownershipRecords(userData)).length === 0
  ));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);

  await withTimeout("packaged app shutdown", 15_000, application.close());
  application = undefined;
  assert.notEqual(applicationProcess.exitCode, null, "Packaged app process did not exit cleanly");
  assert.deepEqual(await ownershipRecords(userData), [], "Packaged app shutdown left process ownership records");
} catch (cause) {
  const output = Buffer.concat(applicationOutput).toString("utf8");
  throw new Error(`Packaged acceptance failed. Process output:\n${output}`, { cause });
} finally {
  if (application) await forceCloseApplication(application);
  await removeTestTree(canonicalTemporary);
}

console.log(`Acceptance-tested packaged application: ${artifact.applicationPath}`);
