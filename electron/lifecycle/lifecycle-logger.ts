import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

export type LifecycleLogLevel = "info" | "warning" | "error";

export interface LifecycleLogRecord {
  readonly level: LifecycleLogLevel;
  readonly event: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface LifecycleLogger {
  addSecrets(values: readonly string[]): void;
  write(record: LifecycleLogRecord): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface LifecycleLoggerOptions {
  readonly logsRoot: string;
  readonly fileName?: string;
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
  readonly maxRecordBytes?: number;
  readonly now?: () => Date;
}

const EVENT_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
  return value;
}

function replaceAll(value: string, needle: string, replacement: string): string {
  return value.split(needle).join(replacement);
}

function boundedJson(record: LifecycleLogRecord, now: Date, secrets: readonly string[], maxBytes: number): Buffer {
  if (!EVENT_PATTERN.test(record.event)) throw new TypeError("Lifecycle log event must be a bounded machine-readable name.");
  const redact = (value: string): string => {
    let result = value;
    for (const secret of secrets) result = replaceAll(result, secret, "[REDACTED]");
    return result;
  };
  let details: unknown;
  if (record.details !== undefined) {
    try {
      details = JSON.parse(redact(JSON.stringify(record.details))) as unknown;
    } catch {
      details = "[unserializable details omitted]";
    }
  }
  const body = {
    timestamp: now.toISOString(),
    level: record.level,
    event: record.event,
    message: redact(record.message),
    ...(details === undefined ? {} : { details }),
  };
  let encoded = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  if (encoded.byteLength <= maxBytes) return encoded;
  encoded = Buffer.from(`${JSON.stringify({
    timestamp: body.timestamp,
    level: body.level,
    event: body.event,
    message: "[oversized lifecycle record omitted]",
  })}\n`, "utf8");
  if (encoded.byteLength > maxBytes) throw new Error("Lifecycle log record limit is too small for its envelope.");
  return encoded;
}

interface RegularFileState {
  readonly exists: boolean;
  readonly size: number;
}

async function regularFileState(filePath: string): Promise<RegularFileState> {
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Lifecycle log path must be a regular file: ${filePath}`);
    }
    return { exists: true, size: metadata.size };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, size: 0 };
    throw cause;
  }
}

export async function createLifecycleLogger(options: LifecycleLoggerOptions): Promise<LifecycleLogger> {
  const canonicalRoot = await realpath(options.logsRoot);
  const fileName = options.fileName ?? "lifecycle.jsonl";
  if (path.basename(fileName) !== fileName || fileName === "." || fileName === "..") {
    throw new TypeError("Lifecycle log file name must be a plain file name.");
  }
  const filePath = path.join(canonicalRoot, fileName);
  const maxFileBytes = positiveInteger(options.maxFileBytes ?? 1024 * 1024, "Lifecycle log file limit");
  const maxFiles = positiveInteger(options.maxFiles ?? 3, "Lifecycle log rotation count");
  if (maxFiles < 2) throw new TypeError("Lifecycle log rotation count must retain at least two files.");
  const maxRecordBytes = positiveInteger(options.maxRecordBytes ?? 64 * 1024, "Lifecycle log record limit");
  if (maxRecordBytes > maxFileBytes) {
    throw new TypeError("Lifecycle log record limit cannot exceed the file limit.");
  }
  const now = options.now ?? (() => new Date());
  const secrets = new Set<string>();
  let queue = Promise.resolve();
  let closed = false;

  const rotatedPath = (index: number): string => path.join(canonicalRoot, `${fileName}.${index}`);
  const rotate = async (): Promise<void> => {
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? filePath : rotatedPath(index - 1);
      const destination = rotatedPath(index);
      const sourceState = await regularFileState(source);
      if (!sourceState.exists) continue;
      const destinationState = await regularFileState(destination);
      if (destinationState.exists) await unlink(destination);
      await rename(source, destination);
    }
  };

  const append = async (record: LifecycleLogRecord): Promise<void> => {
    const encoded = boundedJson(record, now(), [...secrets].sort((left, right) => right.length - left.length), maxRecordBytes);
    const state = await regularFileState(filePath);
    if (state.exists && state.size + encoded.byteLength > maxFileBytes) await rotate();
    const handle = await open(
      filePath,
      fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error("Lifecycle log destination is not a regular file.");
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };

  return {
    addSecrets(values) {
      if (closed) throw new Error("Lifecycle logger is closed.");
      for (const value of values) {
        if (value.length === 0) continue;
        if (Buffer.byteLength(value, "utf8") > 4096 || secrets.size >= 128) {
          throw new Error("Lifecycle logger secret limits were exceeded.");
        }
        secrets.add(value);
      }
    },
    write(record) {
      if (closed) return Promise.reject(new Error("Lifecycle logger is closed."));
      const operation = queue.then(() => append(record));
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    flush() {
      return queue;
    },
    async close() {
      if (closed) return queue;
      closed = true;
      await queue;
      secrets.clear();
    },
  };
}
