import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { assertContainedPath, assertManagedPathParents } from "../security.js";
import type { WorkspacePaths } from "../types.js";
import { DependencyIntegrityError } from "./errors.js";

export interface DependencyPaths {
  readonly root: string;
  readonly snapshotsRoot: string;
  readonly stagingRoot: string;
  readonly quarantineRoot: string;
}

async function ensureRealDirectory(parent: string, name: string): Promise<string> {
  const candidate = path.join(parent, name);
  await assertManagedPathParents(parent, candidate);
  try {
    await mkdir(candidate, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DependencyIntegrityError(`Managed dependency path is not a real directory: ${candidate}`);
  }
  const canonical = await realpath(candidate);
  assertContainedPath(parent, canonical, "Managed dependency directory");
  return canonical;
}

export async function createDependencyPaths(workspacePaths: WorkspacePaths): Promise<DependencyPaths> {
  const root = await ensureRealDirectory(workspacePaths.instanceRoot, "dependencies");
  const snapshotsRoot = await ensureRealDirectory(root, "snapshots");
  const stagingRoot = await ensureRealDirectory(root, "staging");
  const quarantineRoot = await ensureRealDirectory(root, "quarantine");
  return { root, snapshotsRoot, stagingRoot, quarantineRoot };
}

function sameStat(left: import("node:fs").BigIntStats, right: import("node:fs").BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export async function hashStableRegularFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<{ sha256: string; size: number; mode: number }> {
  signal?.throwIfAborted();
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new DependencyIntegrityError(`Dependency input is not a supported regular file: ${filePath}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let position = 0;
    while (position < Number(before.size)) {
      signal?.throwIfAborted();
      const length = Math.min(buffer.byteLength, Number(before.size) - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) throw new DependencyIntegrityError(`Dependency input was truncated: ${filePath}`);
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    if ((await handle.read(overflow, 0, 1, position)).bytesRead !== 0) {
      throw new DependencyIntegrityError(`Dependency input grew while it was read: ${filePath}`);
    }
    const after = await handle.stat({ bigint: true });
    if (!sameStat(before, after)) throw new DependencyIntegrityError(`Dependency input changed while it was read: ${filePath}`);
    return { sha256: hash.digest("hex"), size: Number(before.size), mode: Number(before.mode & 0o777n) };
  } finally {
    await handle.close();
  }
}

export async function readStableRegularFile(
  filePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const metadata = await hashStableRegularFile(filePath, signal);
  if (metadata.size > maxBytes) throw new DependencyIntegrityError(`Dependency input is too large: ${filePath}`);
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || Number(before.size) !== metadata.size) {
      throw new DependencyIntegrityError(`Dependency input changed before it could be decoded: ${filePath}`);
    }
    const bytes = Buffer.alloc(metadata.size);
    let position = 0;
    while (position < bytes.byteLength) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, position, bytes.byteLength - position, position);
      if (bytesRead === 0) throw new DependencyIntegrityError(`Dependency input was truncated: ${filePath}`);
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameStat(before, after) || createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) {
      throw new DependencyIntegrityError(`Dependency input changed while it was decoded: ${filePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const handle = await open(directoryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

async function makeWritable(root: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    await chmod(root, 0o600);
    return;
  }
  await chmod(root, 0o700);
  for (const child of await readdir(root, { withFileTypes: true })) {
    if (!child.isSymbolicLink()) await makeWritable(path.join(root, child.name));
  }
}

export async function removeDependencyTree(root: string): Promise<void> {
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}
