import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSketchServer } from "react-rewrite-cli/dist/server.js";
import WebSocket from "ws";

import type { TextFileChange } from "../../../../src/change-contracts.js";
import type { ActiveProject } from "../../../../src/project-ipc.js";
import { ChangeService } from "../../../changes/change-service.js";
import { ProjectActivityCoordinator } from "../../../projects/project-activity.js";
import { RuntimeWorkspaceProvider } from "../../../runtime-workspaces/provider.js";

async function makeWritable(target: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    await chmod(target, 0o600);
    return;
  }
  await chmod(target, 0o700);
  for (const child of await readdir(target)) await makeWritable(path.join(target, child));
}

async function sendTextEdit(
  port: number,
  origin: string,
  capability: string,
  filePath: string,
): Promise<Record<string, unknown>> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, ["larger", capability], { origin });
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("React Rewrite edit timed out")), 5_000);
      socket.once("error", reject);
      socket.once("open", () => {
        socket.send(JSON.stringify({
          type: "updateText",
          filePath,
          lineNumber: 2,
          columnNumber: 10,
          componentName: "App",
          tagName: "h1",
          originalText: "Before",
          newText: "After",
        }));
      });
      socket.on("message", (value) => {
        const message = JSON.parse(value.toString()) as Record<string, unknown>;
        if (message.type !== "updateTextComplete") return;
        clearTimeout(timeout);
        resolve(message);
      });
    });
  } finally {
    socket.close();
  }
}

test("authenticated React Rewrite edits become reviewable ChangeSets before explicit source apply", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-react-rewrite-loop-"));
  context.after(async () => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, "source");
  const sourceFile = path.join(sourceRoot, "src", "App.tsx");
  const before = [
    "export default function App() {",
    "  return <h1>Before</h1>;",
    "}",
    "",
  ].join("\n");
  await mkdir(path.dirname(sourceFile), { recursive: true });
  await writeFile(sourceFile, before);

  const instanceKey = "react-rewrite-change-loop";
  const provider = new RuntimeWorkspaceProvider({
    userDataPath: path.join(root, "user-data"),
    localInstanceKey: instanceKey,
  });
  let workspace = await provider.stage(sourceRoot);
  const runtimeFile = path.join(workspace.runtimePath, "src", "App.tsx");
  const capability = randomBytes(32).toString("base64url");
  const allowedOrigin = "http://127.0.0.1:45678";
  const server = createSketchServer({
    port: 0,
    host: "127.0.0.1",
    capability,
    allowedOrigin,
    projectRoot: workspace.runtimePath,
  });
  context.after(() => new Promise<void>((resolve) => server.wss.close(() => resolve())));
  if (!server.wss.address()) await new Promise<void>((resolve) => server.wss.once("listening", resolve));
  const address = server.wss.address();
  assert.ok(address && typeof address === "object");

  const edit = await sendTextEdit(address.port, allowedOrigin, capability, runtimeFile);
  assert.equal(edit.success, true, JSON.stringify(edit));
  assert.match(await readFile(runtimeFile, "utf8"), /<h1>After<\/h1>/);
  assert.equal(await readFile(sourceFile, "utf8"), before);

  const active: ActiveProject = {
    generation: 1,
    manifest: {
      schemaVersion: 2,
      projectId: "react-rewrite-change-loop",
      name: "React Rewrite change loop",
      defaultRuntimeProfile: "web",
      runtimeProfiles: {
        web: {
          command: ["pnpm", "dev"],
          workingDirectory: ".",
          dependencyRoot: ".",
          host: "127.0.0.1",
          preferredPort: 4310,
          readiness: { path: "/", timeoutMs: 60_000 },
          entryRoute: "/",
          environment: { literals: {}, inherit: [], secrets: {} },
          runtimeAdapter: "vite",
          editorAdapter: "react-rewrite",
        },
      },
    },
    identity: { projectId: "react-rewrite-change-loop", instanceKey, canonicalPath: sourceRoot },
    detection: {} as ActiveProject["detection"],
    trust: "trusted",
    personalState: {},
    workspace: {
      baselineIdentity: workspace.baselineIdentity,
      runtimeId: workspace.runtimeId,
      preparedAt: new Date().toISOString(),
    },
  };
  const activity = new ProjectActivityCoordinator();
  const changes = new ChangeService({
    userDataPath: path.join(root, "user-data"),
    projects: {
      activeForChanges: () => structuredClone(active),
      authorizeSourceOperation: async () => structuredClone(active),
    },
    workspaces: {
      current: async () => provider.current(),
      for: () => ({
        current: async () => provider.current(),
        resetCurrent: async () => {
          workspace = await provider.resetCurrent();
          return workspace;
        },
      }),
    },
    activity,
  });

  const scanned = await changes.scan(active.generation);
  const changeSet = scanned.snapshot.changeSet;
  assert.ok(changeSet);
  const file = changeSet.files.find((candidate): candidate is TextFileChange => candidate.kind === "text");
  assert.ok(file);
  assert.equal(file.path, "src/App.tsx");
  assert.ok(file.hunks.length > 0);
  assert.equal(await readFile(sourceFile, "utf8"), before);

  const selected = await changes.updateSelection(active.generation, changeSet.id, changeSet.revision, {
    files: [{ fileId: file.id, includeFile: true, hunkIds: file.hunks.map((hunk) => hunk.id) }],
  });
  const selectedSet = selected.snapshot.changeSet;
  assert.ok(selectedSet);
  const prepared = await changes.prepareApply(active.generation, selectedSet.id, selectedSet.revision);
  assert.equal(prepared.status, "prepared");
  assert.ok(prepared.transactionId);
  assert.ok(prepared.planDigest);
  assert.equal(await readFile(sourceFile, "utf8"), before);

  const committed = await changes.commitApply(active.generation, prepared.transactionId, prepared.planDigest);
  assert.equal(committed.snapshot.changeSet?.status, "applied");
  assert.match(await readFile(sourceFile, "utf8"), /<h1>After<\/h1>/);
});
