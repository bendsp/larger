import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { EditorStartInput } from "../../editor-adapter.js";
import type {
  ProcessSupervisor,
  RecoveryOutcome,
  SpawnSupervisedProcessInput,
  SupervisedProcess,
} from "../../process-supervisor.js";
import { RedactingLogBuffer } from "../../redacting-log-buffer.js";
import { ReactRewriteEditorAdapter } from "./react-rewrite-editor-adapter.js";

class CapturingSupervisor implements ProcessSupervisor {
  readonly managedLaunchSupported = true;
  spawned: SpawnSupervisedProcessInput | null = null;

  async spawn(input: SpawnSupervisedProcessInput): Promise<SupervisedProcess> {
    this.spawned = input;
    return {
      role: input.role,
      identity: {
        pid: 1234,
        executable: input.spec.command,
        startedAt: "2026-08-11T00:00:00.000Z",
        processGroupId: 1234,
      },
      exit: new Promise(() => undefined),
    };
  }

  async stop(): Promise<void> {}
  async recover(): Promise<readonly RecoveryOutcome[]> { return []; }
}

function input(runtimePath: string, supervisor: ProcessSupervisor): EditorStartInput {
  return {
    sessionId: "session-1",
    projectInstanceKey: "instance-1",
    projectGeneration: 7,
    runtimeId: "runtime-1",
    runtimePath,
    target: {
      origin: "http://127.0.0.1:3000",
      route: "/work",
      displayUrl: "http://127.0.0.1:3000/work",
      portAllocation: { preferred: 3000, actual: 3000 },
    },
    capability: "A".repeat(64),
    signal: new AbortController().signal,
    supervisor,
    logs: new RedactingLogBuffer(),
  };
}

test("launches the maintained CLI with only explicit private editor state", async (context) => {
  const runtimePath = await mkdtemp(path.join(os.tmpdir(), "larger-react-rewrite-adapter-"));
  context.after(() => rm(runtimePath, { recursive: true, force: true }));
  const supervisor = new CapturingSupervisor();
  const ports = [4100, 4101];
  const adapter = new ReactRewriteEditorAdapter({
    executablePath: "/Applications/Larger.app/Contents/MacOS/Larger",
    cliPath: "/app/node_modules/react-rewrite-cli/bin/react-rewrite.js",
    allocatePort: async () => ports.shift() ?? assert.fail("unexpected port allocation"),
    id: () => "surface-1",
  });

  const started = await adapter.start(input(runtimePath, supervisor));
  const launch = supervisor.spawned;
  assert.ok(launch);
  assert.equal(launch.role, "editor");
  assert.equal(launch.projectGeneration, 7);
  assert.deepEqual(launch.spec.args, [
    "--eval",
    "const cli=process.argv[1];process.argv.splice(1,1);import(cli)",
    "/app/node_modules/react-rewrite-cli/bin/react-rewrite.js",
    "--no-open",
    "--host",
    "127.0.0.1",
    "3000",
  ]);
  assert.deepEqual(Object.keys(launch.spec.environment).sort(), [
    "ELECTRON_RUN_AS_NODE",
    "NO_COLOR",
    "REACT_REWRITE_CAPABILITY",
    "REACT_REWRITE_PROJECT_ROOT",
    "REACT_REWRITE_PROXY_PORT",
    "REACT_REWRITE_WS_PORT",
  ]);
  assert.equal(launch.spec.environment.REACT_REWRITE_PROXY_PORT, "4100");
  assert.equal(launch.spec.environment.REACT_REWRITE_WS_PORT, "4101");
  assert.deepEqual(started.surface, {
    id: "surface-1",
    editorAdapter: "react-rewrite",
    preview: true,
    writable: true,
  });
  assert.equal(adapter.surfaceUrl(started), "http://127.0.0.1:4100/work");
  assert.equal("surfaceUrl" in started.surface, false);
});

test("verifies injected overlay plus rejected and accepted WebSocket handshakes", async (context) => {
  const runtimePath = await mkdtemp(path.join(os.tmpdir(), "larger-react-rewrite-verify-"));
  context.after(() => rm(runtimePath, { recursive: true, force: true }));
  const probes: Array<{ port: number; origin: string; capability: string }> = [];
  const supervisor = new CapturingSupervisor();
  const ports = [4200, 4201];
  const capability = "A".repeat(64);
  const adapter = new ReactRewriteEditorAdapter({
    allocatePort: async () => ports.shift() ?? assert.fail("unexpected port allocation"),
    request: async () => new Response(
      '<script>class LargerAuthenticatedWebSocket {}</script><script src="/__react-rewrite/overlay.js"></script>',
      { status: 200, headers: { "content-type": "text/html" } },
    ),
    websocketProbe: async (port, origin, suppliedCapability) => {
      probes.push({ port, origin, capability: suppliedCapability });
      return origin === "http://127.0.0.1:4200" && suppliedCapability === capability ? 101 : 401;
    },
  });
  const started = await adapter.start({ ...input(runtimePath, supervisor), capability });

  await adapter.verify(started, new AbortController().signal);

  assert.equal(probes.length, 3);
  assert.equal(probes[0]?.capability === capability, false);
  assert.equal(probes[1]?.origin, "http://127.0.0.1:1");
  assert.deepEqual(probes[2], { port: 4201, origin: "http://127.0.0.1:4200", capability });
});

test("waits for the proxy listener before verifying its security boundary", async (context) => {
  const runtimePath = await mkdtemp(path.join(os.tmpdir(), "larger-react-rewrite-readiness-"));
  context.after(() => rm(runtimePath, { recursive: true, force: true }));
  const supervisor = new CapturingSupervisor();
  const ports = [4230, 4231];
  let attempts = 0;
  const adapter = new ReactRewriteEditorAdapter({
    allocatePort: async () => ports.shift() ?? assert.fail("unexpected port allocation"),
    request: async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return new Response(
        '<script>class LargerAuthenticatedWebSocket {}</script><script src="/__react-rewrite/overlay.js"></script>',
        { status: 200 },
      );
    },
    websocketProbe: async (_port, origin, suppliedCapability) => (
      origin === "http://127.0.0.1:4230" && suppliedCapability === "A".repeat(64) ? 101 : 401
    ),
  });
  const started = await adapter.start(input(runtimePath, supervisor));

  await adapter.verify(started, new AbortController().signal);

  assert.equal(attempts, 2);
});

test("bounds editor verification even when the proxy accepts but never responds", async (context) => {
  const runtimePath = await mkdtemp(path.join(os.tmpdir(), "larger-react-rewrite-timeout-"));
  context.after(() => rm(runtimePath, { recursive: true, force: true }));
  const supervisor = new CapturingSupervisor();
  const ports = [4250, 4251];
  const adapter = new ReactRewriteEditorAdapter({
    allocatePort: async () => ports.shift() ?? assert.fail("unexpected port allocation"),
    verificationTimeoutMs: 10,
    request: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const started = await adapter.start(input(runtimePath, supervisor));
  await assert.rejects(
    adapter.verify(started, new AbortController().signal),
    (cause: unknown) => cause instanceof DOMException && cause.name === "TimeoutError",
  );
});

test("rejects an oversized proxy verification body before WebSocket authorization", async (context) => {
  const runtimePath = await mkdtemp(path.join(os.tmpdir(), "larger-react-rewrite-body-limit-"));
  context.after(() => rm(runtimePath, { recursive: true, force: true }));
  const supervisor = new CapturingSupervisor();
  const ports = [4270, 4271];
  let probes = 0;
  const adapter = new ReactRewriteEditorAdapter({
    allocatePort: async () => ports.shift() ?? assert.fail("unexpected port allocation"),
    maxVerificationBytes: 32,
    request: async () => new Response("x".repeat(33), { status: 200 }),
    websocketProbe: async () => {
      probes += 1;
      return 101;
    },
  });
  const started = await adapter.start(input(runtimePath, supervisor));

  await assert.rejects(
    adapter.verify(started, new AbortController().signal),
    /oversized verification response/,
  );
  assert.equal(probes, 0);
});

test("rejects non-literal-loopback and HTTPS targets before spawning", async (context) => {
  const runtimePath = await mkdtemp(path.join(os.tmpdir(), "larger-react-rewrite-target-"));
  context.after(() => rm(runtimePath, { recursive: true, force: true }));
  const supervisor = new CapturingSupervisor();
  const adapter = new ReactRewriteEditorAdapter({ allocatePort: async () => 4300 });

  await assert.rejects(
    adapter.start({
      ...input(runtimePath, supervisor),
      target: { ...input(runtimePath, supervisor).target, origin: "http://localhost:3000" },
    }),
    /loopback HTTP/,
  );
  await assert.rejects(
    adapter.start({
      ...input(runtimePath, supervisor),
      target: { ...input(runtimePath, supervisor).target, origin: "https://127.0.0.1:3000" },
    }),
    /loopback HTTP/,
  );
  assert.equal(supervisor.spawned, null);
});
