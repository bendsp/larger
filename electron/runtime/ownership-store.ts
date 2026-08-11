import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { RuntimeProcessIdentity } from "../../src/runtime-contracts.js";

export const OWNERSHIP_RECORD_VERSION = 1 as const;

export interface RuntimeOwnershipRecord {
  readonly formatVersion: typeof OWNERSHIP_RECORD_VERSION;
  readonly id: string;
  readonly sessionId: string;
  readonly role: "runtime" | "editor";
  readonly nonce: string;
  readonly projectInstanceKey: string;
  readonly projectGeneration: number;
  readonly runtimeId: string;
  readonly runtimePath: string;
  readonly state: "reserved" | "running" | "stopping";
  readonly createdAt: string;
  readonly supervisor: RuntimeProcessIdentity | null;
  readonly process: RuntimeProcessIdentity | null;
}

export interface OwnershipStore {
  put(record: RuntimeOwnershipRecord): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<readonly RuntimeOwnershipRecord[]>;
}

function isIdentity(value: unknown): value is RuntimeProcessIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<RuntimeProcessIdentity>;
  return Number.isInteger(identity.pid) && (identity.pid ?? 0) > 0
    && typeof identity.executable === "string" && identity.executable.length > 0
    && typeof identity.startedAt === "string" && !Number.isNaN(Date.parse(identity.startedAt))
    && (identity.processGroupId === null
      || (Number.isInteger(identity.processGroupId) && (identity.processGroupId ?? 0) > 0));
}

function parseRecord(value: unknown): RuntimeOwnershipRecord {
  if (!value || typeof value !== "object") throw new Error("Ownership record must be an object");
  const record = value as Partial<RuntimeOwnershipRecord>;
  if (
    record.formatVersion !== OWNERSHIP_RECORD_VERSION
    || typeof record.id !== "string"
    || typeof record.sessionId !== "string"
    || (record.role !== "runtime" && record.role !== "editor")
    || typeof record.nonce !== "string" || !/^[a-f0-9]{64}$/.test(record.nonce)
    || typeof record.projectInstanceKey !== "string"
    || !Number.isInteger(record.projectGeneration) || (record.projectGeneration ?? -1) < 0
    || typeof record.runtimeId !== "string"
    || typeof record.runtimePath !== "string" || !path.isAbsolute(record.runtimePath)
    || (record.state !== "reserved" && record.state !== "running" && record.state !== "stopping")
    || typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))
    || (record.supervisor !== null && !isIdentity(record.supervisor))
    || (record.process !== null && !isIdentity(record.process))
  ) {
    throw new Error("Ownership record is invalid");
  }
  return record as RuntimeOwnershipRecord;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class FileOwnershipStore implements OwnershipStore {
  constructor(private readonly directory: string) {}

  async put(record: RuntimeOwnershipRecord): Promise<void> {
    parseRecord(record);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.pathFor(record.id);
    const temporary = path.join(this.directory, `.${record.id}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    await syncDirectory(this.directory);
  }

  async remove(id: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await unlink(this.pathFor(id));
      await syncDirectory(this.directory);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  async list(): Promise<readonly RuntimeOwnershipRecord[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
    const records: RuntimeOwnershipRecord[] = [];
    for (const name of names) {
      const value: unknown = JSON.parse(await readFile(path.join(this.directory, name), "utf8"));
      records.push(parseRecord(value));
    }
    return records;
  }

  private pathFor(id: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("Ownership record id is unsafe");
    return path.join(this.directory, `${id}.json`);
  }
}
