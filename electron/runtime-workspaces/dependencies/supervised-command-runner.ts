import { randomUUID } from "node:crypto";
import { RedactingLogBuffer } from "../../runtime/redacting-log-buffer.js";
import type { ProcessSupervisor, SupervisedProcess } from "../../runtime/process-supervisor.js";
import type {
  DependencyCommandInput,
  DependencyCommandResult,
  DependencyCommandRunner,
} from "./process.js";

const MAX_CAPTURE_BYTES = 256 * 1024;

function appendBounded(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
): Buffer<ArrayBufferLike> {
  if (current.byteLength >= MAX_CAPTURE_BYTES) return current;
  return Buffer.concat([current, chunk.subarray(0, MAX_CAPTURE_BYTES - current.byteLength)]);
}

function definedEnvironment(environment: NodeJS.ProcessEnv | undefined): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(environment ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export class SupervisedDependencyCommandRunner implements DependencyCommandRunner {
  constructor(private readonly options: {
    readonly supervisor: ProcessSupervisor;
    readonly projectInstanceKey: string;
  }) {}

  async run(input: DependencyCommandInput): Promise<DependencyCommandResult> {
    input.signal?.throwIfAborted();
    const operationId = randomUUID();
    const signal = input.signal ?? new AbortController().signal;
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let process: SupervisedProcess | undefined;
    let stopPromise: Promise<void> | undefined;
    const stop = () => {
      if (process && !stopPromise) {
        stopPromise = this.options.supervisor.stop(process).catch(() => undefined);
      }
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      process = await this.options.supervisor.spawn({
        sessionId: operationId,
        role: "runtime",
        projectInstanceKey: this.options.projectInstanceKey,
        projectGeneration: 0,
        runtimeId: `dependency-${operationId}`,
        runtimePath: input.cwd,
        spec: {
          command: input.executable,
          args: [...input.arguments],
          cwd: input.cwd,
          environment: definedEnvironment(input.environment),
        },
        logs: new RedactingLogBuffer(),
        signal,
        onOutput(stream, chunk) {
          if (stream === "stdout") stdout = appendBounded(stdout, chunk);
          else stderr = appendBounded(stderr, chunk);
        },
      });
      if (signal.aborted) {
        stop();
        await stopPromise;
        throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      }
      const result = await process.exit;
      if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      if (result.code !== 0) {
        const detail = stderr.toString("utf8").trim().slice(0, 4_096);
        throw new Error(`Dependency command failed with ${result.code ?? result.signal ?? "unknown"}${detail ? `: ${detail}` : ""}`);
      }
      return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
    } finally {
      signal.removeEventListener("abort", stop);
      if (signal.aborted && process) {
        stop();
        await stopPromise;
      }
    }
  }
}
