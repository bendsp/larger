import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import type {
  EditorSurface,
  ProjectManifest,
  SessionLog,
  SessionSnapshot,
  SessionStartOptions,
} from "../src/contracts.js";
import type { EditorAdapter, EditorAdapterFactory, EditorAdapterEvent } from "./editor-adapter.js";
import { STUDIO_ROOT } from "./manifest.js";
import { stripAnsi, terminateProcess } from "./process.js";
import { createSandbox, inspectSandboxChanges, type SandboxBaseline } from "./sandbox.js";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "project";
}

async function isPortAvailable(port: number, host: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function findAvailablePort(preferredPort: number, host: string): Promise<number> {
  for (let port = preferredPort; port < preferredPort + 50; port += 1) {
    if (await isPortAvailable(port, host)) return port;
  }
  throw new Error(`No available target port near ${preferredPort}`);
}

export function resolveServerLaunch(
  configured: ProjectManifest["project"]["dev"],
  options: SessionStartOptions = {},
): ProjectManifest["project"]["dev"] {
  const host = options.host ?? configured.host;
  const preferredPort = options.preferredPort ?? configured.preferredPort;
  if (!["127.0.0.1", "localhost"].includes(host)) {
    throw new Error("Server host must be localhost or 127.0.0.1");
  }
  if (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65_535) {
    throw new Error("Server port must be an integer between 1024 and 65535");
  }
  return { ...configured, host, preferredPort };
}

async function waitForHttp(
  url: string,
  timeoutMs = 60_000,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "connection refused";
  while (Date.now() < deadline) {
    if (isCancelled()) throw new Error("Session start was cancelled");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Target dev server did not become ready: ${lastError}`);
}

export class SessionManager {
  private targetProcess: ChildProcess | null = null;
  private readonly adapter: EditorAdapter;
  private phase: SessionSnapshot["phase"] = "idle";
  private targetUrl: string | null = null;
  private surface: EditorSurface | null = null;
  private runtimeRoot: string | null = null;
  private error: string | null = null;
  private logs: SessionLog[] = [];
  private cachedChanges: SessionSnapshot["changes"] = [];
  private changesCheckedAt = 0;
  private baseline: SandboxBaseline = new Map();
  private baselineReady = false;
  private generation = 0;
  private startPromise: Promise<SessionSnapshot> | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private cleanupError: string | null = null;
  private adapterGeneration: number | null = null;

  constructor(
    private readonly manifest: ProjectManifest,
    private readonly sourceRoot: string,
    createAdapter: EditorAdapterFactory,
  ) {
    this.adapter = createAdapter((event) => this.handleAdapterEvent(event));
  }

  private handleAdapterEvent(event: EditorAdapterEvent): void {
    if (event.type === "log") {
      this.addLog("adapter", event.message);
      return;
    }
    if (this.adapterGeneration !== null) {
      this.handleUnexpectedExit("adapter", event.code, event.signal, this.adapterGeneration);
    }
  }

  private handleUnexpectedExit(
    source: "target" | "adapter",
    code: number | null,
    signal: string | null,
    generation: number,
  ): void {
    if (generation !== this.generation || ["idle", "stopping", "error"].includes(this.phase)) return;
    this.generation += 1;
    const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    this.error = `${source === "adapter" ? this.adapter.descriptor.name : "Target dev server"} exited unexpectedly (${detail})`;
    this.phase = "error";
    this.addLog("studio", this.error);
    void this.stopProcesses().catch((cleanupError) => {
      this.error = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      this.addLog("studio", this.error);
    });
  }

  private addLog(source: SessionLog["source"], message: string): void {
    const clean = stripAnsi(message).trim();
    if (!clean) return;
    this.logs.push({ at: Date.now(), source, message: clean });
    this.logs = this.logs.slice(-80);
  }

  private assertActiveGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error("Session start was cancelled");
  }

  async start(options: SessionStartOptions = {}): Promise<SessionSnapshot> {
    if (this.cleanupPromise) {
      try {
        await this.cleanupPromise;
      } catch {
        return await this.snapshot();
      }
    }
    if (this.cleanupError) return await this.snapshot();
    if (this.startPromise) return await this.startPromise;
    if (!["idle", "error"].includes(this.phase)) return this.snapshot();

    const operation = this.startInternal(resolveServerLaunch(this.manifest.project.dev, options));
    this.startPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.startPromise === operation) this.startPromise = null;
    }
  }

  private async startInternal(dev: ProjectManifest["project"]["dev"]): Promise<SessionSnapshot> {
    const generation = ++this.generation;
    this.error = null;
    this.logs = [];
    this.cachedChanges = [];
    this.changesCheckedAt = 0;
    this.baselineReady = false;
    this.phase = "preparing";
    this.addLog("studio", "Creating an isolated copy of the current working tree");

    try {
      const project = this.manifest.project;
      this.runtimeRoot = path.join(STUDIO_ROOT, ".larger", "runtime", slugify(project.name));
      this.baseline = await createSandbox(this.sourceRoot, this.runtimeRoot, STUDIO_ROOT);
      this.baselineReady = true;
      this.cachedChanges = [];
      this.changesCheckedAt = 0;
      this.assertActiveGeneration(generation);
      this.addLog("studio", `Sandbox ready at ${this.runtimeRoot}`);

      const port = await findAvailablePort(dev.preferredPort, dev.host);
      this.assertActiveGeneration(generation);
      this.targetUrl = `http://${dev.host}:${port}`;
      const [command, ...configuredArgs] = dev.command;
      const args = configuredArgs.map((argument) => argument.replaceAll("{port}", String(port)));
      this.phase = "starting-target";
      this.addLog("studio", `Starting target on ${this.targetUrl}`);

      const targetProcess = spawn(command, args, {
        cwd: this.runtimeRoot,
        env: { ...process.env, FORCE_COLOR: "0", NODE_ENV: "development" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      this.targetProcess = targetProcess;
      const consumeTarget = (chunk: Buffer) => {
        for (const line of stripAnsi(chunk.toString()).split("\n").map((entry) => entry.trim()).filter(Boolean)) {
          this.addLog("target", line);
        }
      };
      targetProcess.stdout?.on("data", consumeTarget);
      targetProcess.stderr?.on("data", consumeTarget);
      targetProcess.once("error", (processError) => {
        this.addLog("target", processError.message);
        if (this.targetProcess === targetProcess) {
          this.handleUnexpectedExit("target", null, null, generation);
        }
      });
      targetProcess.once("exit", (code, signal) => {
        if (this.targetProcess !== targetProcess) return;
        this.targetProcess = null;
        this.handleUnexpectedExit("target", code, signal, generation);
      });

      await waitForHttp(this.targetUrl, 60_000, () => generation !== this.generation);
      this.assertActiveGeneration(generation);
      this.addLog("studio", `Target responded; starting ${this.adapter.descriptor.name}`);
      this.phase = "starting-adapter";
      this.adapterGeneration = generation;
      const surface = await this.adapter.start({
        workspaceRoot: this.runtimeRoot,
        target: { url: this.targetUrl },
      });
      this.assertActiveGeneration(generation);
      this.surface = surface;
      this.phase = "ready";
      this.addLog("studio", "Canvas ready");
      return await this.snapshot();
    } catch (startError) {
      if (generation !== this.generation) {
        return await this.snapshot();
      }
      this.error = startError instanceof Error ? startError.message : String(startError);
      this.addLog("studio", this.error);
      this.phase = "error";
      await this.stopProcesses();
      return await this.snapshot();
    }
  }

  private stopProcesses(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    const operation = this.performStopProcesses().finally(() => {
      if (this.cleanupPromise === operation) this.cleanupPromise = null;
    });
    this.cleanupPromise = operation;
    return operation;
  }

  private async performStopProcesses(): Promise<void> {
    this.adapterGeneration = null;
    const target = this.targetProcess;
    const [adapterResult, targetResult] = await Promise.allSettled([
      this.adapter.stop(),
      terminateProcess(target),
    ]);
    if (targetResult.status === "fulfilled" && targetResult.value && this.targetProcess === target) {
      this.targetProcess = null;
    }

    const errors: string[] = [];
    if (adapterResult.status === "rejected") errors.push(String(adapterResult.reason));
    if (targetResult.status === "rejected") errors.push(String(targetResult.reason));
    if (targetResult.status === "fulfilled" && !targetResult.value) {
      errors.push("Target process did not exit after SIGKILL");
    }
    if (errors.length > 0) {
      this.cleanupError = `Process cleanup failed: ${errors.join("; ")}`;
      throw new Error(this.cleanupError);
    }
    this.cleanupError = null;
  }

  async stop(): Promise<SessionSnapshot> {
    if (this.phase === "idle" && !this.startPromise && !this.cleanupError) return this.snapshot();
    const inFlightStart = this.startPromise;
    this.generation += 1;
    this.phase = "stopping";
    this.addLog("studio", "Stopping target and canvas processes");
    try {
      await this.stopProcesses();
      if (inFlightStart) await inFlightStart;
      await this.stopProcesses();
    } catch (stopError) {
      this.error = stopError instanceof Error ? stopError.message : String(stopError);
      this.phase = "error";
      this.addLog("studio", this.error);
      return await this.snapshot();
    }
    this.phase = "idle";
    this.targetUrl = null;
    this.surface = null;
    this.error = null;
    return await this.snapshot();
  }

  async snapshot(): Promise<SessionSnapshot> {
    if (this.runtimeRoot && this.baselineReady && Date.now() - this.changesCheckedAt > 1_000) {
      try {
        this.cachedChanges = await inspectSandboxChanges(this.baseline, this.runtimeRoot);
      } catch {
        // A transient scan failure should not take down the live canvas.
      }
      this.changesCheckedAt = Date.now();
    } else if (!this.baselineReady) {
      this.cachedChanges = [];
    }

    return {
      phase: this.phase,
      adapter: this.adapter.descriptor,
      server: {
        mode: "managed",
        configured: { ...this.manifest.project.dev, command: [...this.manifest.project.dev.command] },
        activeUrl: this.targetUrl,
      },
      surface: this.surface,
      error: this.error,
      logs: [...this.logs],
      changes: [...this.cachedChanges],
    };
  }
}
