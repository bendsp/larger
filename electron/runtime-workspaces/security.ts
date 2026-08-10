import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export class WorkspaceSecurityError extends Error {
  override readonly name = "WorkspaceSecurityError";
}

export function assertLocalInstanceKey(key: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(key) || key === "." || key === "..") {
    throw new WorkspaceSecurityError("The local instance key is not a safe path component.");
  }
}

export function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function assertContainedPath(parent: string, candidate: string, label: string): void {
  if (!isContainedPath(parent, candidate)) {
    throw new WorkspaceSecurityError(`${label} escapes its canonical root.`);
  }
}

export function manifestEntryPath(root: string, manifestPath: string): string {
  const segments = manifestPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new WorkspaceSecurityError(`Invalid manifest path: ${manifestPath}`);
  }
  const candidate = path.join(root, ...segments);
  assertContainedPath(root, candidate, "Manifest entry");
  return candidate;
}

export function assertSafeMaterializedSymlink(
  root: string,
  manifestPath: string,
  target: string,
): void {
  if (!target || target.includes("\0") || path.isAbsolute(target)) {
    throw new WorkspaceSecurityError(`Unsafe materialized symlink target for ${manifestPath}`);
  }
  const linkPath = manifestEntryPath(root, manifestPath);
  const resolvedTarget = path.resolve(path.dirname(linkPath), target);
  assertContainedPath(root, resolvedTarget, `Materialized symlink ${manifestPath}`);
}

async function ensureDirectoryWithoutSymlink(parent: string, childName: string): Promise<string> {
  const child = path.join(parent, childName);
  try {
    const stat = await lstat(child);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkspaceSecurityError(`Managed path is not a real directory: ${child}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    try {
      await mkdir(child, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const racedStat = await lstat(child);
      if (racedStat.isSymbolicLink() || !racedStat.isDirectory()) {
        throw new WorkspaceSecurityError(`Managed path is not a real directory: ${child}`);
      }
    }
  }

  const canonical = await realpath(child);
  assertContainedPath(parent, canonical, "Managed directory");
  return canonical;
}

export async function createWorkspacePaths(
  userDataPath: string,
  localInstanceKey: string,
): Promise<import("./types.js").WorkspacePaths> {
  assertLocalInstanceKey(localInstanceKey);
  await mkdir(userDataPath, { recursive: true, mode: 0o700 });
  const canonicalUserData = await realpath(userDataPath);
  const storageRoot = await ensureDirectoryWithoutSymlink(canonicalUserData, "runtime-workspaces");
  const instancesRoot = await ensureDirectoryWithoutSymlink(storageRoot, "instances");
  const instanceRoot = await ensureDirectoryWithoutSymlink(instancesRoot, localInstanceKey);
  const baselinesRoot = await ensureDirectoryWithoutSymlink(instanceRoot, "baselines");
  const runtimesRoot = await ensureDirectoryWithoutSymlink(instanceRoot, "runtimes");
  const stagingRoot = await ensureDirectoryWithoutSymlink(instanceRoot, "staging");

  return {
    userDataPath: canonicalUserData,
    storageRoot,
    instanceRoot,
    baselinesRoot,
    runtimesRoot,
    stagingRoot,
    currentPointerPath: path.join(instanceRoot, "current.json"),
  };
}

export async function assertManagedPathParents(
  canonicalRoot: string,
  candidate: string,
): Promise<void> {
  const resolvedCandidate = path.resolve(candidate);
  assertContainedPath(canonicalRoot, resolvedCandidate, "Managed path");
  const relative = path.relative(canonicalRoot, path.dirname(resolvedCandidate));
  let cursor = canonicalRoot;

  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new WorkspaceSecurityError(`Managed path has a symlinked or non-directory parent: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}
