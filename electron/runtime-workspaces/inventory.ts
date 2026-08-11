import { createHash } from "node:crypto";
import { constants as fsConstants, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertSafeMaterializedSymlink, isContainedPath, manifestEntryPath } from "./security.js";
import type { BaselineManifest, InventoryEntry } from "./types.js";
import { BASELINE_FORMAT_VERSION } from "./types.js";

const EXCLUDED_AT_ANY_DEPTH = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".angular",
  ".astro",
  ".expo",
  ".netlify",
  ".output",
  ".parcel-cache",
  ".pnpm-store",
  ".vercel",
  ".vite",
  ".webpack",
  ".larger-runtime",
  ".larger-runtimes",
  "node_modules",
]);

const EXCLUDED_AT_PROJECT_ROOT = new Set([
  ".larger",
  "coverage",
  "dist",
  "build",
  "out",
  "storybook-static",
]);

const EXCLUDED_YARN_GENERATED_STATE = new Set(["unplugged", "install-state.gz", "build-state.yml"]);

export function isInventoryPathExcluded(relativeDirectory: string, name: string): boolean {
  if (EXCLUDED_AT_ANY_DEPTH.has(name)) return true;
  if (relativeDirectory === "" && EXCLUDED_AT_PROJECT_ROOT.has(name)) return true;
  const insideYarnDirectory = relativeDirectory === ".yarn" || relativeDirectory.endsWith("/.yarn");
  return insideYarnDirectory && EXCLUDED_YARN_GENERATED_STATE.has(name);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

interface SourceFingerprint {
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly size: string;
  readonly modifiedNanoseconds: string;
  readonly changedNanoseconds: string;
}

interface SourceRecord {
  readonly path: string;
  readonly type: InventoryEntry["type"];
  readonly fingerprint: SourceFingerprint;
  readonly symlinkTarget?: string;
}

export interface InventorySnapshot {
  readonly sourceRoot: string;
  readonly entries: readonly InventoryEntry[];
  readonly records: ReadonlyMap<string, SourceRecord>;
}

export class UnsupportedSourceEntryError extends Error {
  override readonly name = "UnsupportedSourceEntryError";

  constructor(
    readonly relativePath: string,
    message: string,
  ) {
    super(`${relativePath || "."}: ${message}`);
  }
}

export class SourceMutationError extends Error {
  override readonly name = "SourceMutationError";

  constructor(readonly relativePath: string) {
    super(`Source changed while its baseline was being captured: ${relativePath || "."}`);
  }
}

function modeOf(stat: { mode: number | bigint }): number {
  return typeof stat.mode === "bigint" ? Number(stat.mode & 0o777n) : stat.mode & 0o777;
}

function fingerprintOf(stat: {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): SourceFingerprint {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: Number(stat.mode & 0o777n),
    size: stat.size.toString(),
    modifiedNanoseconds: stat.mtimeNs.toString(),
    changedNanoseconds: stat.ctimeNs.toString(),
  };
}

function fingerprintsEqual(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.changedNanoseconds === right.changedNanoseconds
  );
}

function toManifestPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function fromManifestPath(root: string, manifestPath: string): string {
  return manifestEntryPath(root, manifestPath);
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function copyAndHashOpenFile(
  sourcePath: string,
  destinationPath: string,
  mode: number,
  signal?: AbortSignal,
): Promise<{ hash: string; before: SourceFingerprint; after: SourceFingerprint }> {
  const source = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const beforeStat = await source.stat({ bigint: true });
    if (!beforeStat.isFile()) {
      throw new UnsupportedSourceEntryError(sourcePath, "entry stopped being a regular file");
    }
    const before = fingerprintOf(beforeStat);
    const hash = createHash("sha256");
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const destination = createWriteStream(destinationPath, { flags: "wx", mode });
    await pipeline(source.createReadStream({ autoClose: false }), hasher, destination, { signal });
    const after = fingerprintOf(await source.stat({ bigint: true }));
    return { hash: hash.digest("hex"), before, after };
  } finally {
    await source.close();
  }
}

async function hashOpenFile(
  filePath: string,
  relativePath: string,
  signal?: AbortSignal,
  onChunk?: (relativePath: string, bytesRead: number) => void,
): Promise<{ hash: string; size: number }> {
  const file = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`Baseline entry type changed: ${relativePath}`);
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Baseline file is too large to verify: ${relativePath}`);
    }
    const hash = createHash("sha256");
    let bytesRead = 0;
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        try {
          signal?.throwIfAborted();
          hash.update(chunk);
          bytesRead += chunk.length;
          onChunk?.(relativePath, bytesRead);
          signal?.throwIfAborted();
          callback();
        } catch (cause) {
          callback(cause as Error);
        }
      },
    });
    await pipeline(file.createReadStream({ autoClose: false }), sink, { signal });
    const after = await file.stat({ bigint: true });
    if (!fingerprintsEqual(fingerprintOf(before), fingerprintOf(after)) || bytesRead !== Number(before.size)) {
      throw new Error(`Baseline file changed while it was being verified: ${relativePath}`);
    }
    return { hash: hash.digest("hex"), size: bytesRead };
  } finally {
    await file.close();
  }
}

function assertStable(relativePath: string, before: SourceFingerprint, after: SourceFingerprint): void {
  if (!fingerprintsEqual(before, after)) {
    throw new SourceMutationError(relativePath);
  }
}

async function assertCanonicalSourcePath(
  sourceRoot: string,
  sourcePath: string,
  relativePath: string,
): Promise<void> {
  let canonical: string;
  try {
    canonical = await realpath(sourcePath);
  } catch {
    throw new SourceMutationError(relativePath);
  }
  if (!isContainedPath(sourceRoot, canonical) || canonical !== path.resolve(sourcePath)) {
    throw new SourceMutationError(relativePath);
  }
}

export async function captureInventory(
  requestedSourceRoot: string,
  baselineTreePath: string,
  signal?: AbortSignal,
  onEntryCaptured?: () => void | Promise<void>,
): Promise<InventorySnapshot> {
  const sourceRoot = await realpath(requestedSourceRoot);
  const rootStat = await lstat(sourceRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new UnsupportedSourceEntryError("", "source root must resolve to a real directory");
  }

  await mkdir(baselineTreePath, { recursive: false, mode: 0o700 });
  const entries: InventoryEntry[] = [];
  const records = new Map<string, SourceRecord>();

  async function visitDirectory(relativeDirectory: string): Promise<void> {
    throwIfAborted(signal);
    const sourceDirectory = relativeDirectory
      ? fromManifestPath(sourceRoot, relativeDirectory)
      : sourceRoot;
    const directoryStat = await lstat(sourceDirectory, { bigint: true });
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new SourceMutationError(relativeDirectory);
    }
    await assertCanonicalSourcePath(sourceRoot, sourceDirectory, relativeDirectory);

    if (relativeDirectory) {
      const destinationDirectory = fromManifestPath(baselineTreePath, relativeDirectory);
      await mkdir(destinationDirectory, { mode: 0o700 });
      const entry: InventoryEntry = {
        path: relativeDirectory,
        type: "directory",
        mode: modeOf(directoryStat),
      };
      entries.push(entry);
      records.set(relativeDirectory, {
        path: relativeDirectory,
        type: "directory",
        fingerprint: fingerprintOf(directoryStat),
      });
    }

    const children = (await readdir(sourceDirectory, { withFileTypes: true })).sort((a, b) =>
      compareUtf8(a.name, b.name),
    );
    for (const child of children) {
      throwIfAborted(signal);
      if (isInventoryPathExcluded(relativeDirectory, child.name)) {
        continue;
      }
      const relativePath = toManifestPath(path.join(relativeDirectory, child.name));
      const sourcePath = fromManifestPath(sourceRoot, relativePath);
      const destinationPath = fromManifestPath(baselineTreePath, relativePath);
      const stat = await lstat(sourcePath, { bigint: true });

      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await visitDirectory(relativePath);
        continue;
      }

      if (stat.isFile() && !stat.isSymbolicLink()) {
        await assertCanonicalSourcePath(sourceRoot, sourcePath, relativePath);
        const copied = await copyAndHashOpenFile(sourcePath, destinationPath, modeOf(stat), signal);
        assertStable(relativePath, fingerprintOf(stat), copied.before);
        assertStable(relativePath, copied.before, copied.after);
        if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new UnsupportedSourceEntryError(relativePath, "file is too large for the baseline manifest format");
        }
        const entry: InventoryEntry = {
          path: relativePath,
          type: "file",
          mode: modeOf(stat),
          size: Number(stat.size),
          contentSha256: copied.hash,
        };
        entries.push(entry);
        records.set(relativePath, {
          path: relativePath,
          type: "file",
          fingerprint: copied.after,
        });
        await onEntryCaptured?.();
        continue;
      }

      if (stat.isSymbolicLink()) {
        const target = await readlink(sourcePath);
        let canonicalTarget: string;
        try {
          canonicalTarget = await realpath(path.resolve(path.dirname(sourcePath), target));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new UnsupportedSourceEntryError(relativePath, "dangling symlinks cannot be materialized safely");
          }
          throw error;
        }
        if (!isContainedPath(sourceRoot, canonicalTarget)) {
          throw new UnsupportedSourceEntryError(relativePath, "external symlinks are outside the project trust boundary");
        }
        const targetRelativePath = toManifestPath(path.relative(sourceRoot, canonicalTarget));
        const destinationTarget = targetRelativePath
          ? fromManifestPath(baselineTreePath, targetRelativePath)
          : baselineTreePath;
        const materializedTarget = path.relative(path.dirname(destinationPath), destinationTarget) || ".";
        await symlink(materializedTarget, destinationPath);
        const entry: InventoryEntry = {
          path: relativePath,
          type: "symlink",
          mode: modeOf(stat),
          target,
          materializedTarget,
          scope: "internal",
        };
        entries.push(entry);
        records.set(relativePath, {
          path: relativePath,
          type: "symlink",
          fingerprint: fingerprintOf(stat),
          symlinkTarget: target,
        });
        const afterLinkStat = await lstat(sourcePath, { bigint: true });
        assertStable(relativePath, fingerprintOf(stat), fingerprintOf(afterLinkStat));
        await onEntryCaptured?.();
        continue;
      }

      throw new UnsupportedSourceEntryError(relativePath, "sockets, devices, FIFOs, and other special files are unsupported");
    }
  }

  await visitDirectory("");
  entries.sort((left, right) => compareUtf8(left.path, right.path));

  for (const entry of entries) {
    if (entry.type !== "symlink") continue;
    const linkPath = fromManifestPath(baselineTreePath, entry.path);
    try {
      const target = await realpath(linkPath);
      if (!isContainedPath(baselineTreePath, target)) {
        throw new UnsupportedSourceEntryError(entry.path, "materialized symlink escapes the baseline");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new UnsupportedSourceEntryError(entry.path, "symlink target is excluded from the baseline");
      }
      throw error;
    }
  }

  return { sourceRoot, entries, records };
}

async function currentRecord(
  sourceRoot: string,
  relativePath: string,
  expectedType: InventoryEntry["type"],
): Promise<SourceRecord> {
  const sourcePath = fromManifestPath(sourceRoot, relativePath);
  const stat = await lstat(sourcePath, { bigint: true });
  const actualType = stat.isSymbolicLink()
    ? "symlink"
    : stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "file"
        : "special";
  if (actualType !== expectedType) {
    throw new SourceMutationError(relativePath);
  }
  if (expectedType !== "symlink") {
    await assertCanonicalSourcePath(sourceRoot, sourcePath, relativePath);
  }
  return {
    path: relativePath,
    type: expectedType,
    fingerprint: fingerprintOf(stat),
    symlinkTarget: expectedType === "symlink" ? await readlink(sourcePath) : undefined,
  };
}

async function listIncludedPaths(sourceRoot: string, signal?: AbortSignal): Promise<string[]> {
  const paths: string[] = [];
  async function walk(relativeDirectory: string): Promise<void> {
    signal?.throwIfAborted();
    const directory = relativeDirectory ? fromManifestPath(sourceRoot, relativeDirectory) : sourceRoot;
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      signal?.throwIfAborted();
      if (isInventoryPathExcluded(relativeDirectory, child.name)) continue;
      const relativePath = toManifestPath(path.join(relativeDirectory, child.name));
      paths.push(relativePath);
      const stat = await lstat(fromManifestPath(sourceRoot, relativePath));
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await walk(relativePath);
      }
    }
  }
  await walk("");
  return paths.sort(compareUtf8);
}

export async function validateSourceSnapshot(snapshot: InventorySnapshot, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const expectedPaths = [...snapshot.records.keys()].sort(compareUtf8);
  let actualPaths: string[];
  try {
    actualPaths = await listIncludedPaths(snapshot.sourceRoot, signal);
  } catch {
    throw new SourceMutationError("");
  }
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new SourceMutationError("");
  }

  for (const [relativePath, expected] of snapshot.records) {
    signal?.throwIfAborted();
    let actual: SourceRecord;
    try {
      actual = await currentRecord(snapshot.sourceRoot, relativePath, expected.type);
    } catch (error) {
      if (error instanceof SourceMutationError) throw error;
      throw new SourceMutationError(relativePath);
    }
    if (
      !fingerprintsEqual(expected.fingerprint, actual.fingerprint) ||
      expected.symlinkTarget !== actual.symlinkTarget
    ) {
      throw new SourceMutationError(relativePath);
    }
  }
}

function updateLengthPrefixed(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  hash.update(String(bytes.length));
  hash.update(":");
  hash.update(bytes);
  hash.update(";");
}

export function computeBaselineIdentity(entries: readonly InventoryEntry[]): string {
  const hash = createHash("sha256");
  updateLengthPrefixed(hash, `larger-baseline-v${BASELINE_FORMAT_VERSION}`);
  for (const entry of [...entries].sort((left, right) => compareUtf8(left.path, right.path))) {
    updateLengthPrefixed(hash, entry.path);
    updateLengthPrefixed(hash, entry.type);
    updateLengthPrefixed(hash, entry.mode.toString(8));
    if (entry.type === "file") {
      updateLengthPrefixed(hash, String(entry.size));
      updateLengthPrefixed(hash, entry.contentSha256);
    } else if (entry.type === "symlink") {
      updateLengthPrefixed(hash, entry.target);
      updateLengthPrefixed(hash, entry.materializedTarget);
    }
  }
  return hash.digest("hex");
}

export function createBaselineManifest(entries: readonly InventoryEntry[]): BaselineManifest {
  const sortedEntries = [...entries].sort((left, right) => compareUtf8(left.path, right.path));
  return {
    formatVersion: BASELINE_FORMAT_VERSION,
    identity: computeBaselineIdentity(sortedEntries),
    entries: sortedEntries,
  };
}

export async function verifyBaselineTree(
  baselineTreePath: string,
  manifest: BaselineManifest,
  signal?: AbortSignal,
  onFileChunk?: (relativePath: string, bytesRead: number) => void,
): Promise<void> {
  signal?.throwIfAborted();
  const rootStat = await lstat(baselineTreePath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Baseline tree is not a real directory for ${manifest.identity}.`);
  }
  if (computeBaselineIdentity(manifest.entries) !== manifest.identity) {
    throw new Error(`Baseline manifest integrity check failed for ${manifest.identity}.`);
  }
  const expectedPaths = manifest.entries.map((entry) => entry.path).sort(compareUtf8);
  const actualPaths: string[] = [];
  async function walk(relativeDirectory: string): Promise<void> {
    signal?.throwIfAborted();
    const directoryPath = relativeDirectory
      ? fromManifestPath(baselineTreePath, relativeDirectory)
      : baselineTreePath;
    for (const child of await readdir(directoryPath, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const relativePath = toManifestPath(path.join(relativeDirectory, child.name));
      actualPaths.push(relativePath);
      if (child.isDirectory() && !child.isSymbolicLink()) await walk(relativePath);
    }
  }
  await walk("");
  actualPaths.sort(compareUtf8);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`Baseline tree shape changed for ${manifest.identity}.`);
  }
  const actualEntries: InventoryEntry[] = [];
  for (const expected of manifest.entries) {
    signal?.throwIfAborted();
    const entryPath = fromManifestPath(baselineTreePath, expected.path);
    const stat = await lstat(entryPath);
    if (expected.type === "directory") {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Baseline entry type changed: ${expected.path}`);
      actualEntries.push({ path: expected.path, type: "directory", mode: expected.mode });
    } else if (expected.type === "file") {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Baseline entry type changed: ${expected.path}`);
      const content = await hashOpenFile(entryPath, expected.path, signal, onFileChunk);
      actualEntries.push({
        path: expected.path,
        type: "file",
        mode: expected.mode,
        size: content.size,
        contentSha256: content.hash,
      });
    } else {
      if (!stat.isSymbolicLink()) throw new Error(`Baseline entry type changed: ${expected.path}`);
      const target = await readlink(entryPath);
      assertSafeMaterializedSymlink(baselineTreePath, expected.path, target);
      if (target !== expected.materializedTarget) throw new Error(`Baseline symlink changed: ${expected.path}`);
      actualEntries.push({ ...expected, mode: expected.mode, materializedTarget: target });
    }
  }
  const identity = computeBaselineIdentity(actualEntries);
  if (identity !== manifest.identity) {
    throw new Error(`Baseline integrity check failed for ${manifest.identity}.`);
  }
}

export async function makeBaselineTreeReadOnly(
  baselineTreePath: string,
  entries: readonly InventoryEntry[],
  signal?: AbortSignal,
): Promise<void> {
  for (const entry of [...entries].reverse()) {
    signal?.throwIfAborted();
    if (entry.type === "symlink") continue;
    const entryPath = fromManifestPath(baselineTreePath, entry.path);
    const readOnlyMode = entry.type === "directory" ? 0o500 : entry.mode & 0o111 ? 0o500 : 0o400;
    await chmod(entryPath, readOnlyMode);
  }
  await chmod(baselineTreePath, 0o500);
}
