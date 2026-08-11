import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CHANGE_SET_FORMAT_VERSION,
  type ByteContentIdentity,
  type ChangeFile,
  type ChangeSelection,
  type ChangeSetSnapshot,
  type ChangeSetStatus,
} from "../../src/change-contracts.js";
import { assertContainedPath } from "../runtime-workspaces/security.js";
import type { WorkspacePaths } from "../runtime-workspaces/types.js";
import { BlobStore, createChangeStoragePaths, type ChangeStoragePaths } from "./blob-store.js";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

interface CurrentRevisionPointer {
  readonly formatVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly snapshotSha256: string;
}

interface ActiveChangeSetPointer {
  readonly formatVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly snapshotSha256: string;
}

const ACTIVE_CHANGE_SET_POINTER_NAME = "current-change-set.json";

function activePointerErrorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined;
  }

  return typeof cause.code === "string" ? cause.code : undefined;
}

function assertContainedActiveChangeSetPath(root: string, candidate: string): void {
  const relativePath = relativeActiveChangeSetPath(
    resolveActiveChangeSetPath(root),
    resolveActiveChangeSetPath(candidate),
  );
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${activePathSeparator}`) ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\")
  ) {
    throw new Error("Active ChangeSet pointer escapes the instance storage root");
  }
}

function decodeActiveChangeSetPointer(value: unknown): ActiveChangeSetPointer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Active ChangeSet pointer must be an object");
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "formatVersion" ||
    keys[1] !== "id" ||
    keys[2] !== "revision" ||
    keys[3] !== "snapshotSha256"
  ) {
    throw new Error("Active ChangeSet pointer has an invalid shape");
  }
  if (record.formatVersion !== 1) {
    throw new Error("Unsupported active ChangeSet pointer version");
  }
  if (
    typeof record.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.id) ||
    record.id === "." ||
    record.id === ".."
  ) {
    throw new Error("Active ChangeSet pointer contains an invalid id");
  }
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1) {
    throw new Error("Active ChangeSet pointer contains an invalid revision");
  }
  if (
    typeof record.snapshotSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.snapshotSha256)
  ) {
    throw new Error("Active ChangeSet pointer contains an invalid snapshot digest");
  }

  return record as unknown as ActiveChangeSetPointer;
}

const STATUS_TRANSITIONS: Readonly<Record<ChangeSetStatus, ReadonlySet<ChangeSetStatus>>> = {
  detected: new Set(["detected", "reviewing", "failed", "discarded"]),
  reviewing: new Set(["reviewing", "applying", "conflicted", "failed", "discarded"]),
  applying: new Set(["applying", "reviewing", "applied", "conflicted", "failed"]),
  applied: new Set(["applied"]),
  conflicted: new Set(["conflicted", "reviewing", "applying", "applied", "failed", "discarded"]),
  discarded: new Set(["discarded"]),
  failed: new Set(["failed", "reviewing", "discarded"]),
};

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function snapshotDigest(snapshot: ChangeSetSnapshot): string {
  return createHash("sha256").update(stableJson(snapshot)).digest("hex");
}

function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID.test(id) || id === "." || id === "..") throw new Error(`${label} is not a safe identifier.`);
}

function assertIdentity(value: unknown, label: string): asserts value is ByteContentIdentity {
  if (
    typeof value !== "object"
    || value === null
    || !("hashAlgorithm" in value)
    || value.hashAlgorithm !== "sha256"
    || !("sha256" in value)
    || typeof value.sha256 !== "string"
    || !SHA256.test(value.sha256)
    || !("byteLength" in value)
    || !Number.isSafeInteger(value.byteLength)
    || Number(value.byteLength) < 0
  ) {
    throw new Error(`${label} has an invalid content identity.`);
  }
}

function assertFile(file: ChangeFile): void {
  assertSafeId(file.id, "Change file ID");
  if (!file.path || file.path.startsWith("/") || file.path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Change file has an invalid manifest path: ${file.path}`);
  }
  if (!new Set(["add", "modify", "delete"]).has(file.operation)) throw new Error("Invalid file operation.");
  if (file.baseline) assertIdentity(file.baseline, file.path);
  if (file.edited) assertIdentity(file.edited, file.path);
  if (file.kind === "text") {
    if (file.operation === "add" && file.baseline !== null) throw new Error(`Addition has baseline content: ${file.path}`);
    if (file.operation === "delete" && file.edited !== null) throw new Error(`Deletion has edited content: ${file.path}`);
    if (file.operation === "modify" && (!file.baseline || !file.edited)) {
      throw new Error(`Modification is missing content identity: ${file.path}`);
    }
    const hunkIds = new Set<string>();
    for (const hunk of file.hunks) {
      assertSafeId(hunk.id, "Hunk ID");
      if (hunkIds.has(hunk.id)) throw new Error(`Text file has duplicate hunk IDs: ${file.path}`);
      hunkIds.add(hunk.id);
    }
  }
}

export function preserveStableSelection(
  previous: ChangeSelection,
  nextFiles: readonly ChangeFile[],
): ChangeSelection {
  const nextById = new Map(nextFiles.map((file) => [file.id, file]));
  const files = previous.files.flatMap((selection) => {
    const file = nextById.get(selection.fileId);
    if (!file || file.kind !== "text") return [];
    const availableHunks = new Set(file.hunks.map((hunk) => hunk.id));
    const hunkIds = selection.hunkIds.filter((id, index, all) => availableHunks.has(id) && all.indexOf(id) === index);
    if (!selection.includeFile && hunkIds.length === 0) return [];
    return [{ fileId: file.id, includeFile: selection.includeFile, hunkIds }];
  });
  return Object.freeze({ files: Object.freeze(files) });
}

function assertSelection(selection: ChangeSelection, files: readonly ChangeFile[]): void {
  const filesById = new Map(files.map((file) => [file.id, file]));
  const selectedFiles = new Set<string>();
  for (const selected of selection.files) {
    if (selectedFiles.has(selected.fileId)) throw new Error(`Selection repeats file ID ${selected.fileId}.`);
    selectedFiles.add(selected.fileId);
    const file = filesById.get(selected.fileId);
    if (!file) throw new Error(`Selection references unknown file ID ${selected.fileId}.`);
    if (file.kind !== "text") throw new Error(`Selection references unsupported file ${selected.fileId}.`);
    if (typeof selected.includeFile !== "boolean") throw new Error(`Selection has no explicit file intent: ${selected.fileId}.`);
    const hunkIds = new Set(file.hunks.map((hunk) => hunk.id));
    const selectedHunks = new Set<string>();
    for (const id of selected.hunkIds) {
      if (!hunkIds.has(id)) throw new Error(`Selection references stale hunk ID ${id}.`);
      if (selectedHunks.has(id)) throw new Error(`Selection repeats hunk ID ${id}.`);
      selectedHunks.add(id);
    }
    if (!selected.includeFile && selected.hunkIds.length > 0) {
      throw new Error(`Hunks cannot be selected while file ${selected.fileId} is excluded.`);
    }
  }
}

function assertSnapshot(value: ChangeSetSnapshot): void {
  if (value.formatVersion !== CHANGE_SET_FORMAT_VERSION) throw new Error("Unsupported ChangeSet format version.");
  assertSafeId(value.id, "ChangeSet ID");
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Invalid ChangeSet revision.");
  if (!value.projectId || !value.instanceKey || !SHA256.test(value.baselineIdentity)) {
    throw new Error("ChangeSet identity fields are invalid.");
  }
  if (value.origin.kind !== "runtime-workspace" || !value.origin.runtimeId) throw new Error("Invalid ChangeSet origin.");
  if (!STATUS_TRANSITIONS[value.status]) throw new Error("Invalid ChangeSet status.");
  if (!Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("ChangeSet timestamps are invalid.");
  }
  const fileIds = new Set<string>();
  const paths = new Set<string>();
  for (const file of value.files) {
    assertFile(file);
    if (fileIds.has(file.id) || paths.has(file.path)) throw new Error("ChangeSet contains duplicate files.");
    fileIds.add(file.id);
    paths.add(file.path);
  }
  assertSelection(value.selection, value.files);
}

function decodeSnapshot(raw: string): ChangeSetSnapshot {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) throw new Error("ChangeSet snapshot is invalid.");
  assertSnapshot(value as ChangeSetSnapshot);
  return value as ChangeSetSnapshot;
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    await syncFile(directoryPath);
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

async function ensureDirectory(parent: string, name: string): Promise<string> {
  const directory = path.join(parent, name);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`ChangeSet path is not a real directory: ${directory}`);
  assertContainedPath(parent, directory, "ChangeSet directory");
  return directory;
}

async function writeImmutable(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await syncFile(filePath);
  await chmod(filePath, 0o400);
}

async function publishPointer(pointerPath: string, pointer: CurrentRevisionPointer): Promise<void> {
  const temporaryPath = `${pointerPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, stableJson(pointer), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await syncFile(temporaryPath);
    await rename(temporaryPath, pointerPath);
    await syncDirectory(path.dirname(pointerPath));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function immutableIdentityMatches(previous: ChangeSetSnapshot, next: ChangeSetSnapshot): boolean {
  return previous.id === next.id
    && previous.projectId === next.projectId
    && previous.instanceKey === next.instanceKey
    && previous.baselineIdentity === next.baselineIdentity
    && previous.origin.kind === next.origin.kind
    && previous.origin.runtimeId === next.origin.runtimeId
    && previous.createdAt === next.createdAt;
}

export class ChangeSetRepository {
  private get activePointerPath(): string {
    return path.join(this.paths.root, ACTIVE_CHANGE_SET_POINTER_NAME);
  }

  async loadCurrent(): Promise<ChangeSetSnapshot | null> {
    assertContainedActiveChangeSetPath(this.paths.root, this.activePointerPath);

    let pointerHandle;
    try {
      pointerHandle = await openActiveChangeSetPointer(
        this.activePointerPath,
        activePointerFsConstants.O_RDONLY | activePointerFsConstants.O_NOFOLLOW,
      );
    } catch (cause) {
      if (activePointerErrorCode(cause) === "ENOENT") {
        return null;
      }
      throw cause;
    }

    let decoded: unknown;
    try {
      const pointerStat = await pointerHandle.stat();
      if (!pointerStat.isFile()) {
        throw new Error("Active ChangeSet pointer is not a regular file");
      }
      if (pointerStat.size > 4_096) {
        throw new Error("Active ChangeSet pointer exceeds its maximum size");
      }
      decoded = JSON.parse(await pointerHandle.readFile("utf8"));
    } catch (cause) {
      throw new Error("Active ChangeSet pointer is unreadable", { cause });
    } finally {
      await pointerHandle.close();
    }
    const pointer = decodeActiveChangeSetPointer(decoded);

    const changeSetDirectory = resolveActiveChangeSetPath(
      this.paths.changeSetsRoot,
      pointer.id,
    );
    assertContainedActiveChangeSetPath(this.paths.changeSetsRoot, changeSetDirectory);

    const snapshot = await this.load(pointer.id, pointer.revision);
    const actualDigest = snapshotDigest(snapshot);
    if (actualDigest !== pointer.snapshotSha256) {
      throw new Error("Active ChangeSet pointer digest does not match its revision");
    }

    return snapshot;
  }

  private operationTail: Promise<void> = Promise.resolve();

  private constructor(
    readonly paths: ChangeStoragePaths,
    readonly blobs: BlobStore,
  ) {}

  static async open(workspacePaths: WorkspacePaths, blobs?: BlobStore): Promise<ChangeSetRepository> {
    const blobStore = blobs ?? await BlobStore.open(workspacePaths);
    return new ChangeSetRepository(await createChangeStoragePaths(workspacePaths), blobStore);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async create(snapshot: ChangeSetSnapshot): Promise<ChangeSetSnapshot> {
    return this.serialize(async () => {
      assertSnapshot(snapshot);
      if (snapshot.revision !== 1) throw new Error("A new ChangeSet must start at revision 1.");
      const directory = path.join(this.paths.changeSetsRoot, snapshot.id);
      try {
        await lstat(directory);
        throw new Error(`ChangeSet already exists: ${snapshot.id}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return this.publish(snapshot);
    });
  }

  async update(snapshot: ChangeSetSnapshot, expectedRevision: number): Promise<ChangeSetSnapshot> {
    return this.serialize(async () => {
      assertSnapshot(snapshot);
      const current = await this.load(snapshot.id);
      if (current.revision !== expectedRevision || snapshot.revision !== expectedRevision + 1) {
        throw new Error(`Stale ChangeSet revision for ${snapshot.id}.`);
      }
      if (!immutableIdentityMatches(current, snapshot)) throw new Error("ChangeSet immutable identity changed.");
      if (!STATUS_TRANSITIONS[current.status].has(snapshot.status)) {
        throw new Error(`Invalid ChangeSet transition: ${current.status} -> ${snapshot.status}.`);
      }
      return this.publish(snapshot);
    });
  }

  private async publish(snapshot: ChangeSetSnapshot): Promise<ChangeSetSnapshot> {
    await this.verifyReferencedBlobs(snapshot);
    const changeSetDirectory = await ensureDirectory(this.paths.changeSetsRoot, snapshot.id);
    const revisionsDirectory = await ensureDirectory(changeSetDirectory, "revisions");
    const digest = snapshotDigest(snapshot);
    const revisionPath = path.join(revisionsDirectory, `${snapshot.revision}-${digest}.json`);
    assertContainedPath(changeSetDirectory, revisionPath, "ChangeSet revision");
    try {
      await writeImmutable(revisionPath, stableJson(snapshot));
      await syncDirectory(revisionsDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(revisionPath, "utf8");
      if (existing !== stableJson(snapshot)) throw new Error("ChangeSet revision digest collision.");
    }
    await publishPointer(path.join(changeSetDirectory, "current.json"), {
      formatVersion: 1,
      id: snapshot.id,
      revision: snapshot.revision,
      snapshotSha256: digest,
    });
    await publishPointer(this.activePointerPath, {
      formatVersion: 1,
      id: snapshot.id,
      revision: snapshot.revision,
      snapshotSha256: snapshotDigest(snapshot),
    });

    return snapshot;
  }

  async load(id: string, revision?: number): Promise<ChangeSetSnapshot> {
    assertSafeId(id, "ChangeSet ID");
    const directory = path.join(this.paths.changeSetsRoot, id);
    const pointerPath = path.join(directory, "current.json");
    const pointerStat = await lstat(pointerPath);
    if (!pointerStat.isFile() || pointerStat.isSymbolicLink()) throw new Error("ChangeSet current pointer is invalid.");
    const pointer = this.decodePointer(await readFile(pointerPath, "utf8"), id);
    if (revision !== undefined && revision !== pointer.revision) {
      const revisions = await this.findRevision(directory, revision);
      return this.loadRevision(revisions.path, revisions.digest);
    }
    const revisionPath = path.join(directory, "revisions", `${pointer.revision}-${pointer.snapshotSha256}.json`);
    return this.loadRevision(revisionPath, pointer.snapshotSha256);
  }

  private decodePointer(raw: string, expectedId: string): CurrentRevisionPointer {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" || value === null
      || !("formatVersion" in value) || value.formatVersion !== 1
      || !("id" in value) || value.id !== expectedId
      || !("revision" in value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
      || !("snapshotSha256" in value) || typeof value.snapshotSha256 !== "string" || !SHA256.test(value.snapshotSha256)
    ) throw new Error("ChangeSet current pointer is invalid.");
    return value as unknown as CurrentRevisionPointer;
  }

  private async findRevision(directory: string, revision: number): Promise<{ path: string; digest: string }> {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid ChangeSet revision.");
    const names = (await readdir(path.join(directory, "revisions"))).filter((name) => name.startsWith(`${revision}-`));
    if (names.length !== 1) throw new Error(`ChangeSet revision is missing or ambiguous: ${revision}.`);
    const name = names[0];
    if (!name) throw new Error("ChangeSet revision is missing.");
    const match = name.match(/^\d+-([a-f0-9]{64})\.json$/);
    if (!match?.[1]) throw new Error("ChangeSet revision filename is invalid.");
    return { path: path.join(directory, "revisions", name), digest: match[1] };
  }

  private async loadRevision(revisionPath: string, expectedDigest: string): Promise<ChangeSetSnapshot> {
    const stat = await lstat(revisionPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("ChangeSet revision is invalid.");
    const raw = await readFile(revisionPath, "utf8");
    const snapshot = decodeSnapshot(raw);
    if (snapshotDigest(snapshot) !== expectedDigest) throw new Error("ChangeSet revision integrity check failed.");
    await this.verifyReferencedBlobs(snapshot);
    return snapshot;
  }

  private async verifyReferencedBlobs(snapshot: ChangeSetSnapshot): Promise<void> {
    const identities = new Map<string, ByteContentIdentity>();
    for (const file of snapshot.files) {
      if (file.baseline) identities.set(file.baseline.sha256, file.baseline);
      if (file.edited) identities.set(file.edited.sha256, file.edited);
    }
    for (const identity of identities.values()) await this.blobs.verify(identity);
  }
}
import {
  open as openActiveChangeSetPointer,
} from "node:fs/promises";
import { constants as activePointerFsConstants } from "node:fs";
import {
  relative as relativeActiveChangeSetPath,
  resolve as resolveActiveChangeSetPath,
  sep as activePathSeparator,
} from "node:path";
