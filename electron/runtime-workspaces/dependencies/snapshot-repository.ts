import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readlink,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createWorkspacePaths, isContainedPath } from "../security.js";
import { DependencyIntegrityError } from "./errors.js";
import {
  createDependencyPaths,
  hashStableRegularFile,
  readStableRegularFile,
  removeDependencyTree,
  syncDirectory,
  syncFile,
} from "./filesystem.js";
import {
  assertSafeDependencyPath,
  assertSha256,
  dependencySnapshotIdentity,
  dependencyTreeIdentity,
} from "./identity.js";
import type {
  DependencyOperationOptions,
  DependencySnapshotEntry,
  DependencySnapshotManifest,
  ResolvedDependencyPlan,
  VerifiedDependencySnapshot,
} from "./types.js";

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const CLONE_FALLBACK_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EINVAL", "EXDEV"]);

function operationOwner(name: string): number | null {
  const match = /^operation-(\d+)-[a-f0-9-]{36}$/.exec(name);
  return match ? Number(match[1]) : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface DependencySnapshotSource {
  readonly nodeModulesPath: string;
  readonly runtimeRoot: string;
}

export interface EnsureDependencySnapshotResult {
  readonly snapshot: VerifiedDependencySnapshot;
  readonly cacheHit: boolean;
}

function waitForSharedOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function clonePrivateFile(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination, fsConstants.COPYFILE_FICLONE_FORCE);
  } catch (error) {
    if (!CLONE_FALLBACK_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    await copyFile(source, destination);
  }
}

function mode(stat: import("node:fs").Stats): number {
  return stat.mode & 0o777;
}

async function captureDependencyTree(
  requestedNodeModulesPath: string,
  requestedRuntimeRoot: string,
  destinationTree: string,
  signal?: AbortSignal,
): Promise<readonly DependencySnapshotEntry[]> {
  signal?.throwIfAborted();
  const [nodeModulesPath, runtimeRoot] = await Promise.all([
    realpath(requestedNodeModulesPath),
    realpath(requestedRuntimeRoot),
  ]);
  if (!isContainedPath(runtimeRoot, nodeModulesPath)) {
    throw new DependencyIntegrityError("Installed dependencies escape their staged runtime.");
  }
  const rootStat = await lstat(nodeModulesPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new DependencyIntegrityError("Installed node_modules must be a real directory.");
  }
  await mkdir(destinationTree, { mode: 0o700 });
  const entries: DependencySnapshotEntry[] = [];

  async function visit(sourceDirectory: string, relativeDirectory: string): Promise<void> {
    signal?.throwIfAborted();
    const beforeNames = (await readdir(sourceDirectory)).sort();
    for (const name of beforeNames) {
      signal?.throwIfAborted();
      const source = path.join(sourceDirectory, name);
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      assertSafeDependencyPath(relative, "Dependency snapshot entry");
      const destination = path.join(destinationTree, ...relative.split("/"));
      const before = await lstat(source);
      if (before.isDirectory() && !before.isSymbolicLink()) {
        await mkdir(destination, { mode: 0o700 });
        entries.push({ path: relative, type: "directory", mode: mode(before) });
        await visit(source, relative);
        const after = await lstat(source);
        if (!after.isDirectory() || after.isSymbolicLink() || mode(after) !== mode(before)) {
          throw new DependencyIntegrityError(`Installed dependency directory changed: ${relative}`);
        }
      } else if (before.isFile() && !before.isSymbolicLink()) {
        const sourceMetadata = await hashStableRegularFile(source, signal);
        await clonePrivateFile(source, destination);
        await chmod(destination, sourceMetadata.mode);
        const copiedMetadata = await hashStableRegularFile(destination, signal);
        const copiedStat = await lstat(destination);
        if (
          sourceMetadata.sha256 !== copiedMetadata.sha256
          || sourceMetadata.size !== copiedMetadata.size
          || copiedStat.nlink !== 1
        ) {
          throw new DependencyIntegrityError(`Dependency file was not captured privately: ${relative}`);
        }
        entries.push({
          path: relative,
          type: "file",
          mode: sourceMetadata.mode,
          size: sourceMetadata.size,
          contentSha256: sourceMetadata.sha256,
        });
      } else if (before.isSymbolicLink()) {
        const target = await readlink(source);
        if (!target || target.includes("\0") || path.isAbsolute(target)) {
          throw new DependencyIntegrityError(`Dependency symlink is not relocatable: ${relative}`);
        }
        const resolved = path.resolve(path.dirname(source), target);
        if (isContainedPath(nodeModulesPath, resolved)) {
          entries.push({
            path: relative,
            type: "symlink",
            mode: mode(before),
            target: { kind: "dependency-internal", relativeTarget: target },
          });
        } else if (isContainedPath(runtimeRoot, resolved)) {
          const runtimeRelativeTarget = path.relative(runtimeRoot, resolved).split(path.sep).join("/");
          assertSafeDependencyPath(runtimeRelativeTarget, `Workspace symlink target for ${relative}`);
          entries.push({
            path: relative,
            type: "symlink",
            mode: mode(before),
            target: { kind: "runtime-workspace", runtimeRelativeTarget },
          });
        } else {
          throw new DependencyIntegrityError(`Dependency symlink escapes the staged runtime: ${relative}`);
        }
        if ((await readlink(source)) !== target) {
          throw new DependencyIntegrityError(`Dependency symlink changed while captured: ${relative}`);
        }
      } else {
        throw new DependencyIntegrityError(`Unsupported dependency entry: ${relative}`);
      }
    }
    const afterNames = (await readdir(sourceDirectory)).sort();
    if (JSON.stringify(beforeNames) !== JSON.stringify(afterNames)) {
      throw new DependencyIntegrityError(`Installed dependency directory changed while captured: ${relativeDirectory || "."}`);
    }
  }

  await visit(nodeModulesPath, "");
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return entries;
}

function parseManifest(value: unknown): DependencySnapshotManifest {
  if (typeof value !== "object" || value === null) throw new DependencyIntegrityError("Dependency manifest is invalid.");
  const manifest = value as Partial<DependencySnapshotManifest>;
  if (
    manifest.formatVersion !== 1
    || typeof manifest.identity !== "string"
    || typeof manifest.treeIdentity !== "string"
    || typeof manifest.createdAt !== "string"
    || !Number.isSafeInteger(manifest.fileCount)
    || !Number.isSafeInteger(manifest.byteCount)
    || !Array.isArray(manifest.entries)
    || typeof manifest.key !== "object"
    || manifest.key === null
  ) {
    throw new DependencyIntegrityError("Dependency manifest has an invalid shape.");
  }
  assertSha256(manifest.identity, "Dependency manifest identity");
  assertSha256(manifest.treeIdentity, "Dependency tree identity");
  if (dependencySnapshotIdentity(manifest.key as DependencySnapshotManifest["key"]) !== manifest.identity) {
    throw new DependencyIntegrityError("Dependency manifest identity does not match its key.");
  }
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    if (typeof entry !== "object" || entry === null || !("path" in entry) || typeof entry.path !== "string") {
      throw new DependencyIntegrityError("Dependency manifest contains an invalid entry.");
    }
    assertSafeDependencyPath(entry.path, "Dependency manifest entry");
    if (seen.has(entry.path)) throw new DependencyIntegrityError("Dependency manifest contains duplicate entries.");
    seen.add(entry.path);
    if (!("type" in entry) || !("mode" in entry) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new DependencyIntegrityError("Dependency manifest entry metadata is invalid.");
    }
    if (entry.type === "file") {
      if (!("size" in entry) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !("contentSha256" in entry) || typeof entry.contentSha256 !== "string") {
        throw new DependencyIntegrityError("Dependency manifest file is invalid.");
      }
      assertSha256(entry.contentSha256, `Dependency file ${entry.path}`);
    } else if (entry.type === "symlink") {
      if (!("target" in entry) || typeof entry.target !== "object" || entry.target === null || !("kind" in entry.target)) {
        throw new DependencyIntegrityError("Dependency manifest symlink is invalid.");
      }
      if (entry.target.kind === "dependency-internal") {
        if (!("relativeTarget" in entry.target) || typeof entry.target.relativeTarget !== "string" || path.isAbsolute(entry.target.relativeTarget)) {
          throw new DependencyIntegrityError("Dependency manifest internal symlink is invalid.");
        }
      } else if (entry.target.kind === "runtime-workspace") {
        if (!("runtimeRelativeTarget" in entry.target) || typeof entry.target.runtimeRelativeTarget !== "string") {
          throw new DependencyIntegrityError("Dependency manifest workspace symlink is invalid.");
        }
        assertSafeDependencyPath(entry.target.runtimeRelativeTarget, "Dependency workspace symlink target");
      } else {
        throw new DependencyIntegrityError("Dependency manifest symlink kind is unsupported.");
      }
    } else if (entry.type !== "directory") {
      throw new DependencyIntegrityError("Dependency manifest entry type is unsupported.");
    }
  }
  if (dependencyTreeIdentity(manifest.entries as readonly DependencySnapshotEntry[]) !== manifest.treeIdentity) {
    throw new DependencyIntegrityError("Dependency tree identity does not match its manifest.");
  }
  const entries = manifest.entries as readonly DependencySnapshotEntry[];
  const fileCount = entries.filter((entry) => entry.type === "file").length;
  const byteCount = entries.reduce((total, entry) => total + (entry.type === "file" ? entry.size : 0), 0);
  if (
    manifest.fileCount !== fileCount
    || manifest.byteCount !== byteCount
    || !Number.isFinite(Date.parse(manifest.createdAt))
  ) {
    throw new DependencyIntegrityError("Dependency manifest summary is invalid.");
  }
  return manifest as DependencySnapshotManifest;
}

async function verifyTree(treePath: string, manifest: DependencySnapshotManifest, signal?: AbortSignal): Promise<void> {
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const seen = new Set<string>();
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const entry = expected.get(relative);
      if (!entry || entry.type === "symlink") throw new DependencyIntegrityError(`Unexpected dependency snapshot entry: ${relative}`);
      seen.add(relative);
      const childPath = path.join(directory, child.name);
      const stat = await lstat(childPath);
      if (entry.type === "directory") {
        if (!stat.isDirectory() || stat.isSymbolicLink() || mode(stat) !== 0o500) {
          throw new DependencyIntegrityError(`Dependency snapshot directory failed verification: ${relative}`);
        }
        await visit(childPath, relative);
      } else {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || mode(stat) !== 0o400) {
          throw new DependencyIntegrityError(`Dependency snapshot file failed verification: ${relative}`);
        }
        const metadata = await hashStableRegularFile(childPath, signal);
        if (metadata.size !== entry.size || metadata.sha256 !== entry.contentSha256) {
          throw new DependencyIntegrityError(`Dependency snapshot file integrity failed: ${relative}`);
        }
      }
    }
  }
  await visit(treePath, "");
  for (const entry of manifest.entries) {
    if (entry.type !== "symlink" && !seen.has(entry.path)) {
      throw new DependencyIntegrityError(`Dependency snapshot entry is missing: ${entry.path}`);
    }
    if (entry.type === "symlink") {
      try {
        await lstat(path.join(treePath, ...entry.path.split("/")));
        throw new DependencyIntegrityError(`Dependency symlink metadata unexpectedly has a live snapshot link: ${entry.path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

async function makeSnapshotReadOnly(treePath: string, entries: readonly DependencySnapshotEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.type === "file") await chmod(path.join(treePath, ...entry.path.split("/")), 0o400);
  }
  for (const entry of [...entries].reverse()) {
    if (entry.type === "directory") await chmod(path.join(treePath, ...entry.path.split("/")), 0o500);
  }
  await chmod(treePath, 0o500);
}

async function syncSealedSnapshotTree(treePath: string, entries: readonly DependencySnapshotEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.type === "file") await syncFile(path.join(treePath, ...entry.path.split("/")));
  }
  for (const entry of [...entries].reverse()) {
    if (entry.type === "directory") await syncDirectory(path.join(treePath, ...entry.path.split("/")));
  }
  await syncDirectory(treePath);
}

export interface DependencySnapshotRepositoryOptions {
  readonly userDataPath: string;
  readonly localInstanceKey: string;
}

export class DependencySnapshotRepository {
  private readonly inFlight = new Map<string, Promise<EnsureDependencySnapshotResult>>();

  private constructor(
    private readonly paths: Awaited<ReturnType<typeof createDependencyPaths>>,
  ) {}

  static async open(options: DependencySnapshotRepositoryOptions): Promise<DependencySnapshotRepository> {
    const workspacePaths = await createWorkspacePaths(options.userDataPath, options.localInstanceKey);
    const repository = new DependencySnapshotRepository(await createDependencyPaths(workspacePaths));
    await repository.recover();
    return repository;
  }

  async recover(): Promise<void> {
    for (const child of await readdir(this.paths.stagingRoot, { withFileTypes: true })) {
      if (child.isDirectory() && !child.isSymbolicLink()) {
        const owner = operationOwner(child.name);
        if (owner !== null && isProcessAlive(owner)) continue;
        await removeDependencyTree(path.join(this.paths.stagingRoot, child.name));
      }
    }
    await syncDirectory(this.paths.stagingRoot);
  }

  async load(identity: string, signal?: AbortSignal): Promise<VerifiedDependencySnapshot | null> {
    assertSha256(identity, "Dependency snapshot identity");
    const snapshotPath = path.join(this.paths.snapshotsRoot, identity);
    let stat;
    try {
      stat = await lstat(snapshotPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DependencyIntegrityError("Dependency snapshot must be a real directory.");
    const manifestPath = path.join(snapshotPath, "manifest.json");
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new DependencyIntegrityError("Dependency snapshot manifest must be a regular file.");
    const manifest = parseManifest(JSON.parse((await readStableRegularFile(manifestPath, MAX_MANIFEST_BYTES, signal)).toString("utf8")) as unknown);
    if (manifest.identity !== identity) throw new DependencyIntegrityError("Dependency snapshot path does not match its identity.");
    const treePath = path.join(snapshotPath, "tree");
    const treeStat = await lstat(treePath);
    if (!treeStat.isDirectory() || treeStat.isSymbolicLink()) throw new DependencyIntegrityError("Dependency snapshot tree must be a real directory.");
    await verifyTree(treePath, manifest, signal);
    return { identity, path: snapshotPath, treePath, manifest };
  }

  ensure(
    plan: ResolvedDependencyPlan,
    build: (operationStagingPath: string) => Promise<DependencySnapshotSource>,
    options: DependencyOperationOptions = {},
  ): Promise<EnsureDependencySnapshotResult> {
    const existing = this.inFlight.get(plan.identity);
    if (existing) return waitForSharedOperation(existing, options.signal);
    const operation = this.ensureOnce(plan, build, options);
    this.inFlight.set(plan.identity, operation);
    void operation.finally(() => {
      if (this.inFlight.get(plan.identity) === operation) this.inFlight.delete(plan.identity);
    }).catch(() => undefined);
    return operation;
  }

  private async ensureOnce(
    plan: ResolvedDependencyPlan,
    build: (operationStagingPath: string) => Promise<DependencySnapshotSource>,
    options: DependencyOperationOptions,
  ): Promise<EnsureDependencySnapshotResult> {
    options.signal?.throwIfAborted();
    const cached = await this.load(plan.identity, options.signal);
    if (cached) return { snapshot: cached, cacheHit: true };
    const operationPath = path.join(this.paths.stagingRoot, `operation-${process.pid}-${randomUUID()}`);
    const stagedSnapshotPath = path.join(operationPath, "snapshot");
    const stagedTreePath = path.join(stagedSnapshotPath, "tree");
    await mkdir(operationPath, { mode: 0o700 });
    await mkdir(stagedSnapshotPath, { mode: 0o700 });
    try {
      const source = await build(operationPath);
      options.signal?.throwIfAborted();
      const entries = await captureDependencyTree(source.nodeModulesPath, source.runtimeRoot, stagedTreePath, options.signal);
      const manifest: DependencySnapshotManifest = {
        formatVersion: 1,
        identity: plan.identity,
        key: plan.key,
        treeIdentity: dependencyTreeIdentity(entries),
        entries,
        createdAt: new Date().toISOString(),
        fileCount: entries.filter((entry) => entry.type === "file").length,
        byteCount: entries.reduce((total, entry) => total + (entry.type === "file" ? entry.size : 0), 0),
      };
      const manifestPath = path.join(stagedSnapshotPath, "manifest.json");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      for (const entry of entries) {
        if (entry.type === "file") await syncFile(path.join(stagedTreePath, ...entry.path.split("/")));
      }
      await syncDirectory(stagedTreePath);
      await syncFile(manifestPath);
      await makeSnapshotReadOnly(stagedTreePath, entries);
      await chmod(manifestPath, 0o400);
      await syncSealedSnapshotTree(stagedTreePath, entries);
      await syncFile(manifestPath);
      await syncDirectory(stagedSnapshotPath);
      options.signal?.throwIfAborted();
      const destination = path.join(this.paths.snapshotsRoot, plan.identity);
      try {
        await rename(stagedSnapshotPath, destination);
        await chmod(destination, 0o500);
        await syncDirectory(destination);
        await syncDirectory(this.paths.snapshotsRoot);
      } catch (error) {
        if (!new Set(["EEXIST", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      const snapshot = await this.load(plan.identity, options.signal);
      if (!snapshot) throw new DependencyIntegrityError("Published dependency snapshot is missing.");
      return { snapshot, cacheHit: false };
    } finally {
      await removeDependencyTree(operationPath);
    }
  }
}
