import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { assertContainedPath } from "../runtime-workspaces/security.js";

export interface AuthorizedSourceRoot {
  readonly canonicalRoot: string;
  readonly device: number;
  readonly inode: number;
}

export interface SourceLeafState {
  readonly kind: "absent" | "file";
  readonly sha256: string | null;
  readonly size: number;
  readonly mode: number | null;
  readonly device: number | null;
  readonly inode: number | null;
}

export class SourceAuthorizationError extends Error {
  override readonly name = "SourceAuthorizationError";
}

function assertRelativeSourcePath(relativePath: string): string[] {
  if (!relativePath || relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw new SourceAuthorizationError("The source path must be a non-empty relative path.");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SourceAuthorizationError("The source path contains an unsafe segment.");
  }
  return segments;
}

export function sourcePath(root: AuthorizedSourceRoot, relativePath: string): string {
  const candidate = path.join(root.canonicalRoot, ...assertRelativeSourcePath(relativePath));
  assertContainedPath(root.canonicalRoot, candidate, "Source path");
  return candidate;
}

export async function authorizeSourceRoot(sourceRoot: string): Promise<AuthorizedSourceRoot> {
  const unresolved = path.resolve(sourceRoot);
  const rootLstat = await lstat(unresolved);
  if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) {
    throw new SourceAuthorizationError("The source root must be a real directory.");
  }
  const canonicalRoot = await realpath(unresolved);
  const rootStat = await stat(canonicalRoot);
  return { canonicalRoot, device: rootStat.dev, inode: rootStat.ino };
}

export async function reauthorizeSourceRoot(expected: AuthorizedSourceRoot): Promise<void> {
  const current = await authorizeSourceRoot(expected.canonicalRoot);
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new SourceAuthorizationError("The source root changed during the operation.");
  }
}

export async function assertSourceParents(
  root: AuthorizedSourceRoot,
  relativePath: string,
  options: { allowMissing?: boolean } = {},
): Promise<void> {
  const segments = assertRelativeSourcePath(relativePath);
  let cursor = root.canonicalRoot;
  await reauthorizeSourceRoot(root);
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new SourceAuthorizationError(`A source parent is not a real directory: ${segment}`);
      }
    } catch (cause) {
      if (options.allowMissing && (cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    const canonical = await realpath(cursor);
    assertContainedPath(root.canonicalRoot, canonical, "Source parent");
    if (canonical !== cursor) {
      throw new SourceAuthorizationError("A source parent resolves through an alias or symlink.");
    }
  }
}

async function hashHandle(handle: Awaited<ReturnType<typeof open>>): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { sha256: hash.digest("hex"), size: position };
}

export async function readSourceLeaf(
  root: AuthorizedSourceRoot,
  relativePath: string,
): Promise<SourceLeafState> {
  await assertSourceParents(root, relativePath, { allowMissing: true });
  const candidate = sourcePath(root, relativePath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) throw new SourceAuthorizationError("The source leaf is not a regular file.");
    const digest = await hashHandle(handle);
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || digest.size !== after.size
    ) {
      throw new SourceAuthorizationError("The source file changed while it was being read.");
    }
    return {
      kind: "file",
      sha256: digest.sha256,
      size: digest.size,
      mode: after.mode & 0o777,
      device: after.dev,
      inode: after.ino,
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent", sha256: null, size: 0, mode: null, device: null, inode: null };
    }
    if ((cause as NodeJS.ErrnoException).code === "ELOOP") {
      throw new SourceAuthorizationError("The source leaf must not be a symbolic link.");
    }
    throw cause;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function sameSourceState(left: SourceLeafState, right: SourceLeafState): boolean {
  return left.kind === right.kind
    && left.sha256 === right.sha256
    && left.size === right.size
    && left.mode === right.mode;
}
