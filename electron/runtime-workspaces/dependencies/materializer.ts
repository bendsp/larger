import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { assertManagedPathParents, isContainedPath } from "../security.js";
import { DependencyIntegrityError } from "./errors.js";
import { hashStableRegularFile, readStableRegularFile, removeDependencyTree, syncDirectory, syncFile } from "./filesystem.js";
import { assertSafeDependencyPath, sha256String } from "./identity.js";
import type {
  DependencyOperationOptions,
  RuntimeDependencyInstallation,
  VerifiedDependencySnapshot,
} from "./types.js";

const MATERIALIZATION_FALLBACK_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EINVAL", "EXDEV"]);

interface RuntimeDependencyMarker {
  readonly formatVersion: 1;
  readonly runtimeId: string;
  readonly snapshotIdentity: string;
  readonly installRootRelativePath: string;
  readonly backend: string;
}

function markerPath(runtimeRoot: string, installRootRelativePath: string): string {
  return path.join(runtimeRoot, ".larger-runtime", "dependencies", `${sha256String(installRootRelativePath)}.json`);
}

async function readMarker(filePath: string): Promise<RuntimeDependencyMarker | null> {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
    throw new DependencyIntegrityError("Runtime dependency marker is invalid.");
  }
  const value = JSON.parse((await readStableRegularFile(filePath, 16 * 1024)).toString("utf8")) as unknown;
  if (
    typeof value !== "object"
    || value === null
    || !("formatVersion" in value)
    || value.formatVersion !== 1
    || !("runtimeId" in value)
    || typeof value.runtimeId !== "string"
    || !("snapshotIdentity" in value)
    || typeof value.snapshotIdentity !== "string"
    || !("installRootRelativePath" in value)
    || typeof value.installRootRelativePath !== "string"
    || !("backend" in value)
    || typeof value.backend !== "string"
  ) {
    throw new DependencyIntegrityError("Runtime dependency marker has an invalid shape.");
  }
  return value as RuntimeDependencyMarker;
}

async function writeMarkerDurably(runtimeRoot: string, marker: RuntimeDependencyMarker): Promise<void> {
  let directory = runtimeRoot;
  for (const segment of [".larger-runtime", "dependencies"]) {
    directory = path.join(directory, segment);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isContainedPath(runtimeRoot, await realpath(directory))) {
      throw new DependencyIntegrityError("Runtime dependency metadata directory is unsafe.");
    }
  }
  const destination = markerPath(runtimeRoot, marker.installRootRelativePath);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await syncFile(temporary);
    await rename(temporary, destination);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
}

function installRootPath(runtimeRoot: string, installRootRelativePath: string): string {
  if (installRootRelativePath === ".") return runtimeRoot;
  assertSafeDependencyPath(installRootRelativePath, "Dependency install root");
  return path.join(runtimeRoot, ...installRootRelativePath.split("/"));
}

async function copyTree(
  snapshot: VerifiedDependencySnapshot,
  runtimeRoot: string,
  destination: string,
  clone: boolean,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(destination, { mode: 0o700 });
  for (const entry of snapshot.manifest.entries) {
    signal?.throwIfAborted();
    const target = path.join(destination, ...entry.path.split("/"));
    if (entry.type === "directory") {
      await mkdir(target, { mode: 0o700 });
    } else if (entry.type === "file") {
      const source = path.join(snapshot.treePath, ...entry.path.split("/"));
      const sourceStat = await lstat(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
        throw new DependencyIntegrityError(`Dependency snapshot file is unsafe: ${entry.path}`);
      }
      await copyFile(source, target, clone ? fsConstants.COPYFILE_FICLONE_FORCE : 0);
      await chmod(target, entry.mode);
      const targetStat = await lstat(target);
      const targetMetadata = await hashStableRegularFile(target, signal);
      if (
        targetStat.nlink !== 1
        || targetMetadata.sha256 !== entry.contentSha256
        || targetMetadata.size !== entry.size
      ) throw new DependencyIntegrityError(`Runtime dependency file is not a verified private copy: ${entry.path}`);
    } else {
      let relativeTarget: string;
      if (entry.target.kind === "dependency-internal") {
        const resolved = path.resolve(path.dirname(target), entry.target.relativeTarget);
        if (!isContainedPath(destination, resolved)) {
          throw new DependencyIntegrityError(`Dependency symlink escapes node_modules: ${entry.path}`);
        }
        relativeTarget = entry.target.relativeTarget;
      } else {
        const runtimeTarget = path.join(runtimeRoot, ...entry.target.runtimeRelativeTarget.split("/"));
        if (!isContainedPath(runtimeRoot, runtimeTarget)) {
          throw new DependencyIntegrityError(`Workspace dependency symlink escapes the runtime: ${entry.path}`);
        }
        const targetStat = await lstat(runtimeTarget);
        if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
          throw new DependencyIntegrityError(`Workspace dependency target must be a real directory: ${entry.path}`);
        }
        relativeTarget = path.relative(path.dirname(target), runtimeTarget) || ".";
      }
      await symlink(relativeTarget, target);
    }
  }
  for (const entry of [...snapshot.manifest.entries].reverse()) {
    if (entry.type === "directory") await chmod(path.join(destination, ...entry.path.split("/")), entry.mode);
  }
  for (const entry of snapshot.manifest.entries) {
    if (entry.type !== "symlink") continue;
    const resolved = await realpath(path.join(destination, ...entry.path.split("/")));
    if (!isContainedPath(runtimeRoot, resolved)) {
      throw new DependencyIntegrityError(`Materialized dependency symlink escapes the runtime: ${entry.path}`);
    }
  }
}

export class DependencyMaterializer {
  async current(
    snapshot: VerifiedDependencySnapshot,
    runtimeRoot: string,
    runtimeId: string,
    installRootRelativePath: string,
  ): Promise<RuntimeDependencyInstallation | null> {
    const canonicalRuntimeRoot = await realpath(runtimeRoot);
    const runtimeMarkerPath = markerPath(canonicalRuntimeRoot, installRootRelativePath);
    await assertManagedPathParents(canonicalRuntimeRoot, runtimeMarkerPath);
    const marker = await readMarker(runtimeMarkerPath);
    if (!marker) return null;
    if (
      marker.runtimeId !== runtimeId
      || marker.snapshotIdentity !== snapshot.identity
      || marker.installRootRelativePath !== installRootRelativePath
    ) return null;
    const nodeModulesPath = path.join(installRootPath(canonicalRuntimeRoot, installRootRelativePath), "node_modules");
    const stat = await lstat(nodeModulesPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DependencyIntegrityError("Runtime node_modules must be a real directory.");
    const canonical = await realpath(nodeModulesPath);
    if (!isContainedPath(canonicalRuntimeRoot, canonical) || canonical !== path.resolve(nodeModulesPath)) {
      throw new DependencyIntegrityError("Runtime node_modules escapes its private runtime.");
    }
    return {
      snapshotIdentity: snapshot.identity,
      runtimeId,
      nodeModulesPath,
      backend: marker.backend,
      reusedCurrent: true,
    };
  }

  async materialize(
    snapshot: VerifiedDependencySnapshot,
    runtimeRoot: string,
    runtimeId: string,
    installRootRelativePath: string,
    options: DependencyOperationOptions = {},
  ): Promise<RuntimeDependencyInstallation> {
    options.signal?.throwIfAborted();
    const canonicalRuntimeRoot = await realpath(runtimeRoot);
    const current = await this.current(snapshot, canonicalRuntimeRoot, runtimeId, installRootRelativePath);
    if (current) return current;
    const installRoot = installRootPath(canonicalRuntimeRoot, installRootRelativePath);
    const canonicalInstallRoot = await realpath(installRoot);
    if (!isContainedPath(canonicalRuntimeRoot, canonicalInstallRoot) || canonicalInstallRoot !== path.resolve(installRoot)) {
      throw new DependencyIntegrityError("Dependency install root escapes the private runtime.");
    }
    const nodeModulesPath = path.join(installRoot, "node_modules");
    try {
      await lstat(nodeModulesPath);
      throw new DependencyIntegrityError("Refusing to replace an unrecognized runtime node_modules tree.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const staging = path.join(installRoot, `.larger-dependencies-${randomUUID()}.staging`);
    let backend = "copy-on-write";
    try {
      try {
        await copyTree(snapshot, canonicalRuntimeRoot, staging, true, options.signal);
      } catch (error) {
        options.signal?.throwIfAborted();
        if (!MATERIALIZATION_FALLBACK_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await removeDependencyTree(staging);
        backend = "portable-copy";
        await copyTree(snapshot, canonicalRuntimeRoot, staging, false, options.signal);
      }
      options.signal?.throwIfAborted();
      await rename(staging, nodeModulesPath);
      await syncDirectory(installRoot);
      await writeMarkerDurably(canonicalRuntimeRoot, {
        formatVersion: 1,
        runtimeId,
        snapshotIdentity: snapshot.identity,
        installRootRelativePath,
        backend,
      });
      return {
        snapshotIdentity: snapshot.identity,
        runtimeId,
        nodeModulesPath,
        backend,
        reusedCurrent: false,
      };
    } finally {
      await removeDependencyTree(staging);
    }
  }
}
