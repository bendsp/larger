import { randomBytes, randomUUID } from "node:crypto";
import { createServer, connect } from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { lstat, realpath } from "node:fs/promises";
import type { EditorAdapter, EditorStartInput, StartedEditor } from "../../editor-adapter.js";
import { resolveReactRewriteCliPath } from "./packaged-resource.js";

const require = createRequire(
  typeof __filename === "string" ? __filename : path.join(process.cwd(), "package.json"),
);
const ELECTRON_CLI_LAUNCHER = "const cli=process.argv[1];process.argv.splice(1,1);import(cli)";

interface ReactRewritePrivateState {
  readonly kind: "react-rewrite";
  readonly surfaceUrl: string;
  readonly proxyOrigin: string;
  readonly websocketPort: number;
  readonly capability: string;
}

export interface ReactRewriteEditorAdapterOptions {
  readonly executablePath?: string;
  readonly cliPath?: string;
  readonly allocatePort?: (signal: AbortSignal) => Promise<number>;
  readonly request?: typeof fetch;
  readonly websocketProbe?: (
    port: number,
    origin: string,
    capability: string,
    signal: AbortSignal,
  ) => Promise<number>;
  readonly verificationTimeoutMs?: number;
  readonly maxVerificationBytes?: number;
  readonly id?: () => string;
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new Error("React Rewrite proxy returned an oversized verification response");
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) {
        throw new Error("React Rewrite proxy returned an oversized verification response");
      }
      text += decoder.decode(result.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function packageCliPath(): string {
  const packageJson = require.resolve("react-rewrite-cli/package.json");
  return resolveReactRewriteCliPath({ packageJsonPath: packageJson, resourcesPath: process.resourcesPath });
}

async function allocateLoopbackPort(signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      server.close();
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      signal.removeEventListener("abort", aborted);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to allocate a loopback editor port");
  }
  await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
  return address.port;
}

function websocketStatus(
  port: number,
  origin: string,
  capability: string,
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    const timer = setTimeout(() => finish(() => reject(new Error("React Rewrite WebSocket probe timed out"))), 5_000);
    const aborted = () => finish(() => reject(signal.reason));
    const finish = (complete: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      socket.destroy();
      complete();
    };
    signal.addEventListener("abort", aborted, { once: true });
    socket.once("error", (cause) => finish(() => reject(cause)));
    socket.once("connect", () => {
      socket.write([
        "GET / HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        `Origin: ${origin}`,
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Protocol: larger, ${capability}`,
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("ascii");
      if (response.length > 16 * 1024) return finish(() => reject(new Error("React Rewrite returned an oversized handshake")));
      if (!response.includes("\r\n\r\n")) return;
      const match = /^HTTP\/1\.1 (\d{3})\b/.exec(response);
      if (!match) return finish(() => reject(new Error("React Rewrite returned an invalid handshake")));
      finish(() => resolve(Number(match[1])));
    });
  });
}

function waitForRetry(signal: AbortSignal, delayMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => finish(resolve), delayMs);
    const aborted = () => finish(() => reject(signal.reason));
    const finish = (complete: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      complete();
    };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function waitForProxyResponse(
  request: typeof fetch,
  surfaceUrl: string,
  signal: AbortSignal,
): Promise<Response> {
  while (true) {
    signal.throwIfAborted();
    try {
      return await request(surfaceUrl, {
        headers: { Accept: "text/html" },
        redirect: "manual",
        signal,
      });
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      if (!(cause instanceof TypeError)) throw cause;
      await waitForRetry(signal);
    }
  }
}

function privateState(started: StartedEditor): ReactRewritePrivateState {
  const state = started.privateState as Partial<ReactRewritePrivateState> | undefined;
  if (state?.kind !== "react-rewrite" || typeof state.surfaceUrl !== "string"
    || typeof state.proxyOrigin !== "string" || typeof state.websocketPort !== "number"
    || typeof state.capability !== "string") {
    throw new Error("React Rewrite editor state is invalid");
  }
  return state as ReactRewritePrivateState;
}

export class ReactRewriteEditorAdapter implements EditorAdapter {
  readonly id = "react-rewrite";
  private readonly executablePath: string;
  private readonly cliPath: string;
  private readonly allocatePort: (signal: AbortSignal) => Promise<number>;
  private readonly request: typeof fetch;
  private readonly websocketProbe: typeof websocketStatus;
  private readonly verificationTimeoutMs: number;
  private readonly maxVerificationBytes: number;
  private readonly createId: () => string;

  constructor(options: ReactRewriteEditorAdapterOptions = {}) {
    this.executablePath = options.executablePath ?? process.execPath;
    this.cliPath = options.cliPath ?? packageCliPath();
    this.allocatePort = options.allocatePort ?? allocateLoopbackPort;
    this.request = options.request ?? fetch;
    this.websocketProbe = options.websocketProbe ?? websocketStatus;
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? 15_000;
    if (!Number.isFinite(this.verificationTimeoutMs) || this.verificationTimeoutMs <= 0) {
      throw new Error("React Rewrite verification timeout must be positive");
    }
    this.maxVerificationBytes = options.maxVerificationBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxVerificationBytes) || this.maxVerificationBytes <= 0) {
      throw new Error("React Rewrite verification response limit must be a positive integer");
    }
    this.createId = options.id ?? randomUUID;
  }

  async start(input: EditorStartInput): Promise<StartedEditor> {
    input.signal.throwIfAborted();
    const target = new URL(input.target.origin);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port) {
      throw new Error("React Rewrite requires a managed loopback HTTP target");
    }
    const runtimePath = await realpath(input.runtimePath);
    const runtimeMetadata = await lstat(runtimePath);
    if (!runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()) {
      throw new Error("React Rewrite requires a canonical runtime directory");
    }
    const proxyPort = await this.allocatePort(input.signal);
    let websocketPort = await this.allocatePort(input.signal);
    while (websocketPort === proxyPort) websocketPort = await this.allocatePort(input.signal);
    const proxyOrigin = `http://127.0.0.1:${proxyPort}`;
    const surfaceUrl = new URL(input.target.route, `${proxyOrigin}/`).toString();

    const process = await input.supervisor.spawn({
      sessionId: input.sessionId,
      role: "editor",
      projectInstanceKey: input.projectInstanceKey,
      projectGeneration: input.projectGeneration,
      runtimeId: input.runtimeId,
      runtimePath,
      spec: {
        command: this.executablePath,
        args: [
          "--eval",
          ELECTRON_CLI_LAUNCHER,
          this.cliPath,
          "--no-open",
          "--host",
          "127.0.0.1",
          target.port,
        ],
        cwd: runtimePath,
        environment: {
          ELECTRON_RUN_AS_NODE: "1",
          NO_COLOR: "1",
          REACT_REWRITE_CAPABILITY: input.capability,
          REACT_REWRITE_PROJECT_ROOT: runtimePath,
          REACT_REWRITE_PROXY_PORT: String(proxyPort),
          REACT_REWRITE_WS_PORT: String(websocketPort),
        },
      },
      logs: input.logs,
      signal: input.signal,
    });

    return {
      process,
      surface: {
        id: this.createId(),
        editorAdapter: this.id,
        preview: true,
        writable: true,
      },
      privateState: {
        kind: "react-rewrite",
        surfaceUrl,
        proxyOrigin,
        websocketPort,
        capability: input.capability,
      } satisfies ReactRewritePrivateState,
    };
  }

  async verify(started: StartedEditor, signal: AbortSignal): Promise<void> {
    const state = privateState(started);
    signal.throwIfAborted();
    const verificationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.verificationTimeoutMs),
    ]);
    const response = await waitForProxyResponse(this.request, state.surfaceUrl, verificationSignal);
    if (!response.ok || response.url && new URL(response.url).origin !== state.proxyOrigin) {
      throw new Error(`React Rewrite proxy verification failed (${response.status})`);
    }
    const html = await readBoundedResponseText(response, this.maxVerificationBytes, verificationSignal);
    if (!html.includes("LargerAuthenticatedWebSocket") || !html.includes("/__react-rewrite/overlay.js")) {
      throw new Error("React Rewrite proxy did not return the maintained authenticated overlay");
    }
    const rejectedCapability = await this.websocketProbe(
      state.websocketPort,
      state.proxyOrigin,
      `${state.capability.slice(0, -1)}x`,
      verificationSignal,
    );
    if (rejectedCapability === 101) throw new Error("React Rewrite accepted an invalid capability");
    const rejectedOrigin = await this.websocketProbe(
      state.websocketPort,
      "http://127.0.0.1:1",
      state.capability,
      verificationSignal,
    );
    if (rejectedOrigin === 101) throw new Error("React Rewrite accepted an invalid origin");
    const accepted = await this.websocketProbe(
      state.websocketPort,
      state.proxyOrigin,
      state.capability,
      verificationSignal,
    );
    if (accepted !== 101) throw new Error("React Rewrite rejected its bound capability and origin");
  }

  surfaceUrl(started: StartedEditor): string {
    return privateState(started).surfaceUrl;
  }
}
