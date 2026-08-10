import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";

export interface JsonStoreCodec<T> {
  decode(value: unknown): T;
  encode(value: T): unknown;
  createDefault(): T;
}

export type JsonStoreReadResult<T> =
  | { status: "loaded"; value: T }
  | { status: "missing"; value: T }
  | { status: "recovered-corruption"; value: T; recoveredPath: string; cause: Error };

export interface AtomicJsonStoreOptions {
  recoverCorruption?: boolean;
  fileMode?: number;
}

export interface AtomicJsonOperationOptions {
  signal?: AbortSignal;
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unsupported on some platforms and filesystems.
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export class VersionedAtomicJsonStore<T> {
  readonly filePath: string;
  private readonly codec: JsonStoreCodec<T>;
  private readonly recoverCorruption: boolean;
  private readonly fileMode: number;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, codec: JsonStoreCodec<T>, options: AtomicJsonStoreOptions = {}) {
    this.filePath = path.resolve(filePath);
    this.codec = codec;
    this.recoverCorruption = options.recoverCorruption ?? true;
    this.fileMode = options.fileMode ?? 0o600;
  }

  async read(): Promise<JsonStoreReadResult<T>> {
    await this.operationQueue;
    return this.readDirect();
  }

  async write(value: T, options: AtomicJsonOperationOptions = {}): Promise<void> {
    await this.enqueue(async () => {
      options.signal?.throwIfAborted();
      await this.writeDirect(value, options.signal);
    });
  }

  async update(
    mutator: (current: T) => T | Promise<T>,
    options: AtomicJsonOperationOptions = {},
  ): Promise<T> {
    let updated: T | undefined;
    await this.enqueue(async () => {
      options.signal?.throwIfAborted();
      const current = (await this.readDirect()).value;
      updated = await mutator(current);
      options.signal?.throwIfAborted();
      await this.writeDirect(updated, options.signal);
    });
    return updated as T;
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readDirect(): Promise<JsonStoreReadResult<T>> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "missing", value: this.codec.createDefault() };
      }
      throw cause;
    }

    try {
      return { status: "loaded", value: this.codec.decode(JSON.parse(text)) };
    } catch (cause) {
      const failure = asError(cause);
      if (!this.recoverCorruption) throw failure;
      const recoveredPath = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
      try {
        await rename(this.filePath, recoveredPath);
        await syncDirectory(path.dirname(this.filePath));
      } catch (renameCause) {
        if ((renameCause as NodeJS.ErrnoException).code !== "ENOENT") throw renameCause;
      }
      return {
        status: "recovered-corruption",
        value: this.codec.createDefault(),
        recoveredPath,
        cause: failure,
      };
    }
  }

  private async writeDirect(value: T, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const encoded = this.codec.encode(value);
    const serialized = JSON.stringify(encoded, null, 2);
    if (serialized === undefined) throw new Error("JSON store codec returned a non-serializable root value");
    const body = `${serialized}\n`;
    const temporaryPath = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporaryPath, "wx", this.fileMode);
      await handle.writeFile(body, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      signal?.throwIfAborted();
      await rename(temporaryPath, this.filePath);
      await syncDirectory(directory);
    } catch (cause) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw cause;
    }
  }
}
