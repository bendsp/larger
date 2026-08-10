import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

export interface CanvasStartInput {
  projectRoot: string;
  host: string;
  port: number;
}

export interface CanvasEngineSession {
  proxyUrl: string;
  websocketUrl: string | null;
}

export interface CanvasEngine {
  readonly id: string;
  readonly version: string;
  start(input: CanvasStartInput): Promise<CanvasEngineSession>;
  stop(): Promise<void>;
}

type LogHandler = (message: string) => void;

const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function parseReactRewriteOutput(value: string): Partial<CanvasEngineSession> {
  const clean = stripAnsi(value);
  const proxy = clean.match(/Proxy:\s+(https?:\/\/[^\s]+)/)?.[1];
  const websocket = clean.match(/WebSocket:\s+(wss?:\/\/[^\s]+)/)?.[1];
  return {
    ...(proxy ? { proxyUrl: proxy } : {}),
    ...(websocket ? { websocketUrl: websocket } : {}),
  };
}

export class LineBuffer {
  private pending = "";

  push(value: string): string[] {
    const lines = `${this.pending}${stripAnsi(value)}`.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    return lines;
  }

  flush(): string | null {
    const pending = this.pending;
    this.pending = "";
    return pending || null;
  }
}

async function terminateProcess(child: ChildProcess | null): Promise<boolean> {
  if (!child?.pid || child.exitCode !== null) return true;
  const exitPromise = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  try {
    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    child.kill("SIGTERM");
  }

  const exited = await Promise.race([
    exitPromise,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (exited || child.exitCode !== null || !child.pid) return true;

  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
  const killed = await Promise.race([
    exitPromise,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  return killed || child.exitCode !== null;
}

export class ReactRewriteEngine implements CanvasEngine {
  readonly id = "react-rewrite";
  readonly version = "0.1.1";
  private child: ChildProcess | null = null;
  private stopping = false;

  constructor(
    private readonly onLog: LogHandler,
    private readonly onExit: (code: number | null, signal: NodeJS.Signals | null) => void,
  ) {}

  async start(input: CanvasStartInput): Promise<CanvasEngineSession> {
    if (this.child) throw new Error("React Rewrite is already running");

    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve("react-rewrite-cli/package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      bin: Record<string, string>;
    };
    const binary = path.resolve(path.dirname(packageJsonPath), packageJson.bin["react-rewrite"]);
    const args = [binary, String(input.port), "--host", input.host, "--no-open"];

    const child = spawn(process.execPath, args, {
      cwd: input.projectRoot,
      env: { ...process.env, FORCE_COLOR: "0", LOG_LEVEL: "info" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child = child;

    return await new Promise<CanvasEngineSession>((resolve, reject) => {
      let settled = false;
      let proxyUrl: string | undefined;
      let websocketUrl: string | null = null;
      const stdoutBuffer = new LineBuffer();
      const stderrBuffer = new LineBuffer();
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("React Rewrite did not publish a proxy URL within 30 seconds"));
      }, 30_000);

      const consumeLine = (value: string) => {
        const message = value.trim();
        if (!message) return;
        this.onLog(message);
        const parsed = parseReactRewriteOutput(message);
        proxyUrl = parsed.proxyUrl ?? proxyUrl;
        websocketUrl = parsed.websocketUrl ?? websocketUrl;
        if (proxyUrl && websocketUrl && !settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({ proxyUrl, websocketUrl });
        }
      };

      const consume = (buffer: LineBuffer) => (chunk: Buffer) => {
        for (const line of buffer.push(chunk.toString())) consumeLine(line);
      };

      child.stdout?.on("data", consume(stdoutBuffer));
      child.stderr?.on("data", consume(stderrBuffer));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        for (const remainder of [stdoutBuffer.flush(), stderrBuffer.flush()]) {
          if (remainder) consumeLine(remainder);
        }
        const isCurrent = this.child === child;
        if (isCurrent) this.child = null;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`React Rewrite exited before it was ready (code ${code ?? "unknown"})`));
          return;
        }
        if (isCurrent && !this.stopping) this.onExit(code, signal);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    try {
      const stopped = await terminateProcess(child);
      if (stopped && this.child === child) this.child = null;
      if (!stopped) throw new Error("React Rewrite did not exit after SIGKILL");
    } finally {
      this.stopping = false;
    }
  }
}

export { terminateProcess };
