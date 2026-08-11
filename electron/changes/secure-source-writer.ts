import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  assertSourceParents,
  readSourceLeaf,
  reauthorizeSourceRoot,
  sameSourceState,
  sourcePath,
  type AuthorizedSourceRoot,
  type SourceLeafState,
} from "./source-authorization.js";
import { isUnsupportedDirectoryFsyncError } from "../storage/versioned-atomic-json-store.js";

export type SourceWriteOperation =
  | { readonly kind: "replace"; readonly bytes: Uint8Array; readonly mode?: number }
  | { readonly kind: "delete" };

export interface SecureSourceWriteRequest {
  readonly root: AuthorizedSourceRoot;
  readonly relativePath: string;
  readonly expected: SourceLeafState;
  readonly operation: SourceWriteOperation;
  readonly plannedDirectories?: readonly string[];
  readonly temporaryName?: string;
  readonly onDirectoriesCreated?: (relativeDirectories: readonly string[]) => Promise<void>;
  readonly onIntentDurable: () => Promise<void>;
  readonly onSourceDurable: () => Promise<void>;
}

export interface SecureSourceWriteResult {
  readonly before: SourceLeafState;
  readonly after: SourceLeafState;
  readonly createdDirectories: readonly string[];
}

export class SourceCompareAndSwapError extends Error {
  override readonly name = "SourceCompareAndSwapError";
}

export function isUnsupportedSourceDirectoryFsyncError(
  cause: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && isUnsupportedDirectoryFsyncError(cause, platform);
}

function temporaryPathFor(parent: string, temporaryName: string): string {
  if (
    path.basename(temporaryName) !== temporaryName
    || !/^\.larger-[0-9a-f-]{36}-[a-f0-9]{16}\.tmp$/.test(temporaryName)
  ) {
    throw new SourceCompareAndSwapError("The prepared temporary filename is invalid.");
  }
  return path.join(parent, temporaryName);
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (!isUnsupportedSourceDirectoryFsyncError(cause)) {
      throw cause;
    }
  }
}

async function createParentDirectories(
  root: AuthorizedSourceRoot,
  relativePath: string,
  plannedDirectories: readonly string[],
): Promise<string[]> {
  const segments = relativePath.split("/").slice(0, -1);
  const planned = new Set(plannedDirectories);
  const created: string[] = [];
  let cursor = root.canonicalRoot;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const relativeDirectory = path.relative(root.canonicalRoot, cursor).split(path.sep).join("/");
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new SourceCompareAndSwapError("A source parent is not a real directory.");
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      if (!planned.has(relativeDirectory)) {
        throw new SourceCompareAndSwapError(`An unplanned source parent is missing: ${relativeDirectory}`);
      }
      await mkdir(cursor, { mode: 0o755 });
      const createdEntry = await lstat(cursor);
      if (createdEntry.isSymbolicLink() || !createdEntry.isDirectory()) {
        throw new SourceCompareAndSwapError("A raced source parent is not a real directory.");
      }
      await syncDirectory(path.dirname(cursor));
      created.push(relativeDirectory);
    }
  }
  await assertSourceParents(root, relativePath);
  return created;
}

export async function findMissingSourceDirectories(
  root: AuthorizedSourceRoot,
  relativePath: string,
): Promise<string[]> {
  sourcePath(root, relativePath);
  await assertSourceParents(root, relativePath, { allowMissing: true });
  const segments = relativePath.split("/").slice(0, -1);
  const missing: string[] = [];
  let cursor = root.canonicalRoot;
  let foundMissing = false;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const relativeDirectory = path.relative(root.canonicalRoot, cursor).split(path.sep).join("/");
    if (foundMissing) {
      missing.push(relativeDirectory);
      continue;
    }
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new SourceCompareAndSwapError("A source parent is not a real directory.");
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      foundMissing = true;
      missing.push(relativeDirectory);
    }
  }
  return missing;
}

export async function removeCreatedDirectories(
  root: AuthorizedSourceRoot,
  relativeDirectories: readonly string[],
): Promise<void> {
  for (const relativeDirectory of [...relativeDirectories].reverse()) {
    const directory = path.dirname(sourcePath(root, `${relativeDirectory}/.larger-directory-sentinel`));
    try {
      const entry = await lstat(directory);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new SourceCompareAndSwapError("A planned source directory is no longer a real directory.");
      }
      await rmdir(directory);
      await syncDirectory(path.dirname(directory));
    } catch (cause) {
      if (!["ENOENT", "ENOTEMPTY"].includes((cause as NodeJS.ErrnoException).code ?? "")) throw cause;
    }
  }
}

export async function removePreparedTemporaryFile(
  root: AuthorizedSourceRoot,
  relativePath: string,
  temporaryName: string | null,
): Promise<void> {
  if (!temporaryName) return;
  await reauthorizeSourceRoot(root);
  const destination = sourcePath(root, relativePath);
  const temporaryPath = temporaryPathFor(path.dirname(destination), temporaryName);
  try {
    const entry = await lstat(temporaryPath);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new SourceCompareAndSwapError("The prepared temporary path is not a regular file.");
    }
    await assertSourceParents(root, relativePath);
    await unlink(temporaryPath);
    await syncDirectory(path.dirname(temporaryPath));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
}

export async function writeSourceFileSecurely(
  request: SecureSourceWriteRequest,
): Promise<SecureSourceWriteResult> {
  const { root, relativePath, expected, operation } = request;
  await reauthorizeSourceRoot(root);
  const plannedDirectories = request.plannedDirectories
    ?? (operation.kind === "replace" ? await findMissingSourceDirectories(root, relativePath) : []);
  const createdDirectories = operation.kind === "replace"
    ? await createParentDirectories(root, relativePath, plannedDirectories)
    : [];
  if (createdDirectories.length > 0) await request.onDirectoriesCreated?.(createdDirectories);
  await assertSourceParents(root, relativePath);
  let current = await readSourceLeaf(root, relativePath);
  if (!sameSourceState(current, expected)) {
    await removeCreatedDirectories(root, createdDirectories);
    throw new SourceCompareAndSwapError(`Source changed before apply: ${relativePath}`);
  }

  const destination = sourcePath(root, relativePath);
  const parent = path.dirname(destination);
  const parentBefore = await stat(parent);
  let temporaryPath: string | null = null;
  try {
    if (operation.kind === "replace") {
      temporaryPath = request.temporaryName
        ? temporaryPathFor(parent, request.temporaryName)
        : path.join(parent, `.${path.basename(destination)}.larger-${randomUUID()}.tmp`);
      if (request.temporaryName) {
        await removePreparedTemporaryFile(root, relativePath, request.temporaryName);
      }
      const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, operation.mode ?? current.mode ?? 0o644);
      try {
        await handle.writeFile(operation.bytes);
        await handle.sync();
        await handle.chmod(operation.mode ?? current.mode ?? 0o644);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }

    await request.onIntentDurable();
    await reauthorizeSourceRoot(root);
    await assertSourceParents(root, relativePath);
    const parentAfter = await stat(parent);
    if (parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino) {
      throw new SourceCompareAndSwapError("The source parent changed before replacement.");
    }
    current = await readSourceLeaf(root, relativePath);
    if (!sameSourceState(current, expected)) {
      throw new SourceCompareAndSwapError(`Source changed immediately before apply: ${relativePath}`);
    }

    if (operation.kind === "replace") {
      await rename(temporaryPath!, destination);
      temporaryPath = null;
    } else if (current.kind === "file") {
      await unlink(destination);
    }
    await syncDirectory(parent);
    const after = await readSourceLeaf(root, relativePath);
    await request.onSourceDurable();
    return { before: current, after, createdDirectories };
  } catch (cause) {
    if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
    throw cause;
  }
}
