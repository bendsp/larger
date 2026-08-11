import { createHash, randomUUID } from "node:crypto";
import { constants as immutablePlanFsConstants } from "node:fs";
import { mkdir, open, open as openImmutablePlan, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertContainedPath, assertLocalInstanceKey } from "../runtime-workspaces/security.js";
import { VersionedAtomicJsonStore } from "../storage/versioned-atomic-json-store.js";
import { DEFAULT_TEXT_DECODE_LIMITS } from "./text-codec.js";
import type { SourceLeafState } from "./source-authorization.js";

export const SOURCE_TRANSACTION_FORMAT_VERSION = 1 as const;
export const MAX_TRANSACTION_BLOB_BYTES = DEFAULT_TEXT_DECODE_LIMITS.maxBytes;

export type SourceTransactionState =
  | "prepared"
  | "committing"
  | "committed"
  | "rolling-back"
  | "rolled-back"
  | "conflicted";

export type TransactionFileState =
  | "pending"
  | "replacement-intent"
  | "applied"
  | "already-satisfied"
  | "conflicted"
  | "rolled-back"
  | "rollback-conflict";

export interface TransactionBlobRef {
  readonly sha256: string;
  readonly size: number;
  readonly fileName: string;
}

export interface SourceTransactionFile {
  readonly path: string;
  readonly operation: "replace" | "delete";
  readonly expected: SourceLeafState;
  readonly result: SourceLeafState;
  readonly backup: TransactionBlobRef | null;
  readonly replacement: TransactionBlobRef | null;
  readonly mode: number | null;
  readonly temporaryName: string;
  readonly state: TransactionFileState;
  readonly plannedDirectories: readonly string[];
  readonly createdDirectories: readonly string[];
  readonly message?: string;
}

export interface SourceTransactionJournal {
  readonly formatVersion: typeof SOURCE_TRANSACTION_FORMAT_VERSION;
  readonly transactionId: string;
  readonly changeSetId: string;
  readonly changeSetRevision: number;
  readonly projectId: string;
  readonly instanceKey: string;
  readonly projectGeneration: number;
  readonly canonicalSourceRoot: string;
  readonly sourceRootDevice: number;
  readonly sourceRootInode: number;
  readonly baselineIdentity: string;
  readonly runtimeId: string;
  readonly planDigest: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: SourceTransactionState;
  readonly files: readonly SourceTransactionFile[];
}

const leafStateSchema = z.object({
  kind: z.enum(["absent", "file"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  size: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative().nullable(),
  device: z.number().int().nonnegative().nullable(),
  inode: z.number().int().nonnegative().nullable(),
}).strict();

const blobRefSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  fileName: z.string().regex(/^[a-f0-9]{64}\.blob$/),
}).strict();

const transactionFileSchema = z.object({
  path: z.string().min(1),
  operation: z.enum(["replace", "delete"]),
  expected: leafStateSchema,
  result: leafStateSchema,
  backup: blobRefSchema.nullable(),
  replacement: blobRefSchema.nullable(),
  mode: z.number().int().nonnegative().nullable(),
  temporaryName: z.string(),
  state: z.enum(["pending", "replacement-intent", "applied", "already-satisfied", "conflicted", "rolled-back", "rollback-conflict"]),
  plannedDirectories: z.array(z.string()),
  createdDirectories: z.array(z.string()),
  message: z.string().optional(),
}).strict();

const journalSchema = z.object({
  formatVersion: z.literal(SOURCE_TRANSACTION_FORMAT_VERSION),
  transactionId: z.string().uuid(),
  changeSetId: z.string().min(1),
  changeSetRevision: z.number().int().nonnegative(),
  projectId: z.string().min(1),
  instanceKey: z.string().min(1),
  projectGeneration: z.number().int().nonnegative(),
  canonicalSourceRoot: z.string().min(1),
  sourceRootDevice: z.number().int().nonnegative(),
  sourceRootInode: z.number().int().nonnegative(),
  baselineIdentity: z.string().min(1),
  runtimeId: z.string().min(1),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  state: z.enum(["prepared", "committing", "committed", "rolling-back", "rolled-back", "conflicted"]),
  files: z.array(transactionFileSchema),
}).strict();

function storeFor(filePath: string): VersionedAtomicJsonStore<SourceTransactionJournal> {
  return new VersionedAtomicJsonStore<SourceTransactionJournal>(filePath, {
    decode: decodeAndValidateJournal,
    encode: decodeAndValidateJournal,
    createDefault: () => { throw new Error("A transaction journal cannot be synthesized."); },
  }, { recoverCorruption: false });
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function compareJournalPaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isHardenedJournalIdentifier(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function assertSafeJournalPath(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`${label} must be a safe relative POSIX path`);
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain empty, current, or parent segments`);
  }
}

function assertLeafState(
  leaf: SourceTransactionJournal["files"][number]["expected"],
  label: string,
): void {
  if (leaf.kind === "absent") {
    if (
      leaf.sha256 !== null ||
      leaf.size !== 0 ||
      leaf.mode !== null ||
      leaf.device !== null ||
      leaf.inode !== null
    ) {
      throw new Error(`${label} absent state contains file metadata`);
    }
    return;
  }

  if (
    leaf.sha256 === null ||
    !/^[0-9a-f]{64}$/.test(leaf.sha256) ||
    leaf.mode === null ||
    leaf.mode < 0 ||
    leaf.mode > 0o777 ||
    (leaf.device === null) !== (leaf.inode === null)
  ) {
    throw new Error(`${label} file state is incomplete or invalid`);
  }
}

function assertBlobMatchesLeaf(
  blob: SourceTransactionJournal["files"][number]["backup"],
  leaf: SourceTransactionJournal["files"][number]["expected"],
  label: string,
): void {
  if (leaf.kind === "absent") {
    if (blob !== null) {
      throw new Error(`${label} must be null for an absent leaf`);
    }
    return;
  }

  if (
    blob === null ||
    blob.sha256 !== leaf.sha256 ||
    blob.size !== leaf.size ||
    blob.size > MAX_TRANSACTION_BLOB_BYTES ||
    blob.fileName !== `${blob.sha256}.blob`
  ) {
    throw new Error(`${label} does not match its file leaf`);
  }
}

function journalPlanValue(journal: SourceTransactionJournal): unknown {
  return {
    changeSetId: journal.changeSetId,
    changeSetRevision: journal.changeSetRevision,
    projectId: journal.projectId,
    instanceKey: journal.instanceKey,
    baselineIdentity: journal.baselineIdentity,
    runtimeId: journal.runtimeId,
    files: journal.files.map((file) => ({
      path: file.path,
      operation: file.operation,
      expected: file.expected,
      result: file.result,
      mode: file.mode,
      temporaryName: file.temporaryName,
    })),
  };
}

function immutableJournalValue(journal: SourceTransactionJournal): unknown {
  return {
    formatVersion: journal.formatVersion,
    transactionId: journal.transactionId,
    changeSetId: journal.changeSetId,
    changeSetRevision: journal.changeSetRevision,
    projectId: journal.projectId,
    instanceKey: journal.instanceKey,
    projectGeneration: journal.projectGeneration,
    canonicalSourceRoot: journal.canonicalSourceRoot,
    sourceRootDevice: journal.sourceRootDevice,
    sourceRootInode: journal.sourceRootInode,
    baselineIdentity: journal.baselineIdentity,
    runtimeId: journal.runtimeId,
    planDigest: journal.planDigest,
    createdAt: journal.createdAt,
    files: journal.files.map((file) => ({
      path: file.path,
      operation: file.operation,
      expected: file.expected,
      result: file.result,
      backup: file.backup,
      replacement: file.replacement,
      mode: file.mode,
      temporaryName: file.temporaryName,
      plannedDirectories: file.plannedDirectories,
    })),
  };
}

function immutableJournalDigest(journal: SourceTransactionJournal): string {
  return transactionPlanDigest(immutableJournalValue(journal));
}

const IMMUTABLE_PLAN_FILE_NAME = "immutable-plan.json";

interface ImmutablePlanRecord {
  readonly formatVersion: 1;
  readonly transactionId: string;
  readonly digest: string;
}

function immutablePlanRecord(journal: SourceTransactionJournal): ImmutablePlanRecord {
  return {
    formatVersion: 1,
    transactionId: journal.transactionId,
    digest: immutableJournalDigest(journal),
  };
}

function decodeImmutablePlanRecord(value: unknown): ImmutablePlanRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Immutable transaction plan must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "digest" ||
    keys[1] !== "formatVersion" ||
    keys[2] !== "transactionId" ||
    record.formatVersion !== 1 ||
    typeof record.transactionId !== "string" ||
    !isHardenedJournalIdentifier(record.transactionId) ||
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.digest)
  ) {
    throw new Error("Immutable transaction plan has an invalid shape");
  }
  return record as unknown as ImmutablePlanRecord;
}

async function writeImmutablePlan(
  transactionDirectory: string,
  journal: SourceTransactionJournal,
): Promise<void> {
  const filePath = path.join(transactionDirectory, IMMUTABLE_PLAN_FILE_NAME);
  const handle = await openImmutablePlan(filePath, "wx", 0o400);
  try {
    await handle.writeFile(`${JSON.stringify(immutablePlanRecord(journal))}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(transactionDirectory);
}

async function verifyImmutablePlan(
  transactionDirectory: string,
  journal: SourceTransactionJournal,
): Promise<void> {
  const filePath = path.join(transactionDirectory, IMMUTABLE_PLAN_FILE_NAME);
  const handle = await openImmutablePlan(
    filePath,
    immutablePlanFsConstants.O_RDONLY | immutablePlanFsConstants.O_NOFOLLOW,
  );
  let raw: unknown;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Immutable transaction plan is not a regular file");
    }
    if (stat.size > 4_096) {
      throw new Error("Immutable transaction plan exceeds its maximum size");
    }
    raw = JSON.parse(await handle.readFile("utf8"));
  } catch (cause) {
    throw new Error("Immutable transaction plan is unreadable", { cause });
  } finally {
    await handle.close();
  }
  const record = decodeImmutablePlanRecord(raw);
  if (record.transactionId !== journal.transactionId) {
    throw new Error("Immutable transaction plan belongs to another transaction");
  }
  if (record.digest !== immutableJournalDigest(journal)) {
    throw new Error("Transaction journal no longer matches its immutable plan");
  }
}

function validateTransactionDirectories(
  filePath: string,
  directories: readonly string[],
  label: string,
): Set<string> {
  const seen = new Set<string>();
  let previous: string | null = null;
  for (const directory of directories) {
    assertSafeJournalPath(directory, label);
    if (!filePath.startsWith(`${directory}/`)) {
      throw new Error(`${label} must be an ancestor of its transaction file`);
    }
    if (
      seen.has(directory) ||
      (previous !== null && compareJournalPaths(previous, directory) >= 0)
    ) {
      throw new Error(`${label} entries must be unique and sorted`);
    }
    seen.add(directory);
    previous = directory;
  }
  return seen;
}

function decodeAndValidateJournal(value: unknown): SourceTransactionJournal {
  const journal = journalSchema.parse(value);
  if (!isHardenedJournalIdentifier(journal.instanceKey)) {
    throw new Error("Transaction journal contains an invalid instance key");
  }
  if (!isHardenedJournalIdentifier(journal.transactionId)) {
    throw new Error("Transaction journal contains an invalid transaction id");
  }
  if (
    journal.canonicalSourceRoot.includes("\0") ||
    !path.isAbsolute(journal.canonicalSourceRoot) ||
    path.normalize(journal.canonicalSourceRoot) !== journal.canonicalSourceRoot
  ) {
    throw new Error("Transaction journal contains a non-canonical source root");
  }

  let previousPath: string | null = null;
  for (const file of journal.files) {
    assertSafeJournalPath(file.path, "Transaction file path");
    if (previousPath !== null && compareJournalPaths(previousPath, file.path) >= 0) {
      throw new Error("Transaction file paths must be unique and sorted");
    }
    previousPath = file.path;

    const plannedDirectories = validateTransactionDirectories(
      file.path,
      file.plannedDirectories,
      "Planned directory",
    );
    const createdDirectories = validateTransactionDirectories(
      file.path,
      file.createdDirectories,
      "Created directory",
    );
    for (const directory of createdDirectories) {
      if (!plannedDirectories.has(directory)) {
        throw new Error("Created directories must be a subset of the immutable directory plan");
      }
    }

    assertLeafState(file.expected, "Expected");
    assertLeafState(file.result, "Result");
    assertBlobMatchesLeaf(file.backup, file.expected, "Backup blob");
    assertBlobMatchesLeaf(file.replacement, file.result, "Replacement blob");

    if (
      !file.temporaryName.startsWith(`.larger-${journal.transactionId}-`)
      || !/^\.larger-[0-9a-f-]{36}-[a-f0-9]{16}\.tmp$/.test(file.temporaryName)
    ) {
      throw new Error("Transaction temporary name is invalid or belongs to another transaction");
    }

    if (file.operation === "delete") {
      if (
        file.expected.kind !== "file"
        || file.result.kind !== "absent"
        || file.mode !== null
      ) {
        throw new Error("Delete operation has inconsistent leaf states");
      }
    } else if (
      file.result.kind !== "file" ||
      file.mode === null ||
      file.mode !== file.result.mode
    ) {
      throw new Error("Replacement operation has inconsistent result metadata");
    }
  }

  const actualPlanDigest = transactionPlanDigest(journalPlanValue(journal));
  if (actualPlanDigest !== journal.planDigest) {
    throw new Error("Transaction journal plan digest does not match its immutable plan");
  }

  return journal;
}

export class SourceTransactionRepository {
  readonly transactionsRoot: string;

  private constructor(transactionsRoot: string) {
    this.transactionsRoot = transactionsRoot;
  }

  static async create(instanceRoot: string, instanceKey: string): Promise<SourceTransactionRepository> {
    assertLocalInstanceKey(instanceKey);
    const canonicalInstanceRoot = await realpath(instanceRoot);
    const transactionsRoot = path.join(canonicalInstanceRoot, "transactions");
    await mkdir(transactionsRoot, { recursive: true, mode: 0o700 });
    const canonicalTransactions = await realpath(transactionsRoot);
    assertContainedPath(canonicalInstanceRoot, canonicalTransactions, "Transaction storage");
    return new SourceTransactionRepository(canonicalTransactions);
  }

  newTransactionId(): string {
    return randomUUID();
  }

async createJournal(journal: SourceTransactionJournal, blobs: ReadonlyMap<string, Uint8Array>): Promise<void> {
    const parsed = decodeAndValidateJournal(journal);
    const directory = this.transactionDirectory(parsed.transactionId);
    await mkdir(path.join(directory, "blobs"), { recursive: true, mode: 0o700 });
    for (const [expectedSha256, bytes] of blobs) {
      const actualSha256 = createHash("sha256").update(bytes).digest("hex");
      if (actualSha256 !== expectedSha256) throw new Error("Transaction blob digest mismatch.");
      const blobPath = path.join(directory, "blobs", `${actualSha256}.blob`);
      const handle = await open(blobPath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await syncDirectory(path.join(directory, "blobs"));
    await writeImmutablePlan(directory, parsed);
    await storeFor(path.join(directory, "journal.json")).write(parsed);
    await syncDirectory(directory);
  }

  async read(transactionId: string): Promise<SourceTransactionJournal> {
    const journal = decodeAndValidateJournal(await this.readUnchecked(transactionId));
    await verifyImmutablePlan(this.transactionDirectory(transactionId), journal);
    return journal;
  }

  private async readUnchecked(transactionId: string): Promise<SourceTransactionJournal> {
    const result = await storeFor(path.join(this.transactionDirectory(transactionId), "journal.json")).read();
    if (result.status === "missing") throw new Error("Transaction journal is missing.");
    return result.value;
  }

  async update(
    transactionId: string,
    mutator: (current: SourceTransactionJournal) => SourceTransactionJournal,
  ): Promise<SourceTransactionJournal> {
    const verifiedCurrent = await this.read(transactionId);
    const verifiedImmutableDigest = immutableJournalDigest(verifiedCurrent);
    return this.updateUnchecked(transactionId, (rawCurrent) => {
      const current = decodeAndValidateJournal(rawCurrent);
      if (immutableJournalDigest(current) !== verifiedImmutableDigest) {
        throw new Error("Transaction journal changed after immutable-plan verification");
      }
      const next = decodeAndValidateJournal(mutator(current));
      if (verifiedImmutableDigest !== immutableJournalDigest(next)) {
        throw new Error("Transaction journal update attempted to mutate its immutable plan");
      }
      return next;
    });
  }

  private async updateUnchecked(
    transactionId: string,
    mutator: (journal: SourceTransactionJournal) => SourceTransactionJournal,
  ): Promise<SourceTransactionJournal> {
    const store = storeFor(path.join(this.transactionDirectory(transactionId), "journal.json"));
    return store.update((current) => journalSchema.parse(mutator(current)) as SourceTransactionJournal);
  }

  async readBlob(transactionId: string, reference: TransactionBlobRef): Promise<Buffer> {
    if (
      !/^[0-9a-f]{64}$/.test(reference.sha256)
      || reference.fileName !== `${reference.sha256}.blob`
      || !Number.isSafeInteger(reference.size)
      || reference.size < 0
      || reference.size > MAX_TRANSACTION_BLOB_BYTES
    ) {
      throw new Error("Transaction blob reference is invalid.");
    }
    const blobPath = path.join(this.transactionDirectory(transactionId), "blobs", reference.fileName);
    const handle = await open(
      blobPath,
      immutablePlanFsConstants.O_RDONLY
        | immutablePlanFsConstants.O_NOFOLLOW
        | (immutablePlanFsConstants.O_NONBLOCK ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Transaction blob is not a regular file.");
      if (stat.size !== reference.size) {
        throw new Error("Transaction blob size does not match its immutable reference.");
      }
      const bytes = Buffer.alloc(reference.size);
      let offset = 0;
      while (offset < reference.size) {
        const { bytesRead } = await handle.read(bytes, offset, reference.size - offset, offset);
        if (bytesRead === 0) throw new Error("Transaction blob ended before its immutable size.");
        offset += bytesRead;
      }
      const overflowProbe = Buffer.alloc(1);
      const { bytesRead: overflowBytes } = await handle.read(overflowProbe, 0, 1, reference.size);
      const finalStat = await handle.stat();
      if (overflowBytes !== 0 || !finalStat.isFile() || finalStat.size !== reference.size) {
        throw new Error("Transaction blob size changed during verification.");
      }
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== reference.sha256 || bytes.length !== reference.size) {
        throw new Error("Transaction blob failed integrity verification.");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  private transactionDirectory(transactionId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(transactionId)) throw new Error("Invalid transaction ID.");
    const directory = path.join(this.transactionsRoot, transactionId);
    assertContainedPath(this.transactionsRoot, directory, "Transaction directory");
    return directory;
  }
}

export function transactionBlobReference(bytes: Uint8Array): TransactionBlobRef {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { sha256, size: bytes.byteLength, fileName: `${sha256}.blob` };
}

export function transactionPlanDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
