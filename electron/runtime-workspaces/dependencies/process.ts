import { spawn } from "node:child_process";

const MAX_CAPTURE_BYTES = 256 * 1024;

export interface DependencyCommandInput {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export interface DependencyCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface DependencyCommandRunner {
  run(input: DependencyCommandInput): Promise<DependencyCommandResult>;
}

function appendBounded(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  if (current.byteLength >= MAX_CAPTURE_BYTES) return current;
  return Buffer.concat([current, chunk.subarray(0, MAX_CAPTURE_BYTES - current.byteLength)]);
}

async function terminateProcessTree(child: import("node:child_process").ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => killer.once("close", () => resolve()));
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("close", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!exited) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

export async function runDependencyCommand(input: DependencyCommandInput): Promise<DependencyCommandResult> {
  input.signal?.throwIfAborted();
  const child = spawn(input.executable, [...input.arguments], {
    cwd: input.cwd,
    env: input.environment,
    detached: process.platform !== "win32",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  child.stdout?.on("data", (chunk: Buffer<ArrayBufferLike>) => { stdout = appendBounded(stdout, chunk); });
  child.stderr?.on("data", (chunk: Buffer<ArrayBufferLike>) => { stderr = appendBounded(stderr, chunk); });

  let aborted = false;
  const abort = () => {
    aborted = true;
    void terminateProcessTree(child);
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (aborted || input.signal?.aborted) throw input.signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
    if (result.code !== 0) {
      const detail = stderr.toString("utf8").trim().slice(0, 4_096);
      throw new Error(`Dependency command failed with ${result.code ?? result.signal ?? "unknown"}${detail ? `: ${detail}` : ""}`);
    }
    return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
  } finally {
    input.signal?.removeEventListener("abort", abort);
    if (input.signal?.aborted) await terminateProcessTree(child);
  }
}

export class DirectDependencyCommandRunner implements DependencyCommandRunner {
  run(input: DependencyCommandInput): Promise<DependencyCommandResult> {
    return runDependencyCommand(input);
  }
}
