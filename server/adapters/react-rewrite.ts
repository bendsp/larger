import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { EditorAdapterDescriptor, EditorSurface } from "../../src/contracts.js";
import type {
  EditorAdapter,
  EditorAdapterEventHandler,
  EditorStartInput,
} from "../editor-adapter.js";
import { stripAnsi, terminateProcess } from "../process.js";

interface ReactRewriteEndpoints {
  proxyUrl: string;
  websocketUrl: string;
}

const require = createRequire(import.meta.url);
const packagePath = require.resolve("react-rewrite-cli/package.json");
const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8")) as {
  version: string;
  bin: Record<string, string>;
};

export const REACT_REWRITE_DESCRIPTOR: EditorAdapterDescriptor = {
  id: "react-rewrite",
  name: "React Rewrite",
  version: packageMetadata.version,
  supports: {
    platforms: ["web"],
    runtimes: ["react"],
  },
  capabilities: {
    selection: "embedded",
    sourceNavigation: "embedded",
    textEditing: "embedded",
    styleEditing: "embedded",
    layoutEditing: "embedded",
    history: "embedded",
  },
  maxClients: 1,
};

export function parseReactRewriteOutput(value: string): Partial<ReactRewriteEndpoints> {
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

export class ReactRewriteAdapter implements EditorAdapter {
  readonly descriptor = REACT_REWRITE_DESCRIPTOR;
  private child: ChildProcess | null = null;
  private stopping = false;

  constructor(private readonly emit: EditorAdapterEventHandler) {}

  async start(input: EditorStartInput): Promise<EditorSurface> {
    if (this.child) throw new Error("React Rewrite is already running");

    const target = new URL(input.target.url);
    if (target.protocol !== "http:" || !target.port) {
      throw new Error("React Rewrite requires an HTTP target with an explicit port");
    }
    const binary = path.resolve(path.dirname(packagePath), packageMetadata.bin["react-rewrite"]);
    const args = [binary, target.port, "--host", target.hostname, "--no-open"];
    const child = spawn(process.execPath, args, {
      cwd: input.workspaceRoot,
      env: { ...process.env, FORCE_COLOR: "0", LOG_LEVEL: "info" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child = child;

    const endpoints = await new Promise<ReactRewriteEndpoints>((resolve, reject) => {
      let settled = false;
      let proxyUrl: string | undefined;
      let websocketUrl: string | undefined;
      const stdoutBuffer = new LineBuffer();
      const stderrBuffer = new LineBuffer();
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("React Rewrite did not publish its endpoints within 30 seconds"));
      }, 30_000);

      const consumeLine = (value: string) => {
        const message = value.trim();
        if (!message) return;
        this.emit({ type: "log", message });
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
        if (isCurrent && !this.stopping) {
          this.emit({ type: "exit", code, signal });
        }
      });
    });

    return {
      kind: "web-url",
      url: endpoints.proxyUrl,
      embedding: "native-view",
    };
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
