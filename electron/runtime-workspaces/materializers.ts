import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { assertContainedPath, assertSafeMaterializedSymlink } from "./security.js";
import type { BaselineManifest, InventoryEntry, MaterializationBackend } from "./types.js";

function entryPath(root: string, entry: InventoryEntry): string {
  const destination = path.join(root, ...entry.path.split("/"));
  assertContainedPath(root, destination, "Materialized entry");
  return destination;
}

abstract class FileCopyMaterializer implements MaterializationBackend {
  abstract readonly name: string;
  protected abstract copy(source: string, destination: string): Promise<void>;

  async materialize(
    baselineTreePath: string,
    destinationPath: string,
    manifest: BaselineManifest,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await mkdir(destinationPath, { recursive: false, mode: 0o700 });

    for (const entry of manifest.entries) {
      signal?.throwIfAborted();
      const source = entryPath(baselineTreePath, entry);
      const destination = entryPath(destinationPath, entry);
      if (entry.type === "directory") {
        await mkdir(destination, { mode: 0o700 });
      } else if (entry.type === "file") {
        const sourceStat = await lstat(source);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
          throw new Error(`Baseline entry is no longer a regular file: ${entry.path}`);
        }
        await this.copy(source, destination);
        await chmod(destination, entry.mode);
      } else {
        const sourceStat = await lstat(source);
        if (!sourceStat.isSymbolicLink() || (await readlink(source)) !== entry.materializedTarget) {
          throw new Error(`Baseline symlink changed: ${entry.path}`);
        }
        assertSafeMaterializedSymlink(destinationPath, entry.path, entry.materializedTarget);
        await symlink(entry.materializedTarget, destination);
      }
    }

    for (const entry of [...manifest.entries].reverse()) {
      if (entry.type === "directory") await chmod(entryPath(destinationPath, entry), entry.mode);
    }
  }
}

export class CopyOnWriteMaterializer extends FileCopyMaterializer {
  readonly name = "copy-on-write";

  protected async copy(source: string, destination: string): Promise<void> {
    await copyFile(source, destination, fsConstants.COPYFILE_FICLONE_FORCE);
  }
}

export class PortableCopyMaterializer extends FileCopyMaterializer {
  readonly name = "portable-copy";

  protected async copy(source: string, destination: string): Promise<void> {
    await copyFile(source, destination);
  }
}

const FALLBACK_ERROR_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EINVAL", "EXDEV"]);

export class FallbackMaterializer implements MaterializationBackend {
  readonly name: string;

  constructor(
    private readonly preferred: MaterializationBackend = new CopyOnWriteMaterializer(),
    private readonly fallback: MaterializationBackend = new PortableCopyMaterializer(),
  ) {
    this.name = `${preferred.name}-with-${fallback.name}-fallback`;
  }

  async materialize(
    baselineTreePath: string,
    destinationPath: string,
    manifest: BaselineManifest,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.preferred.materialize(baselineTreePath, destinationPath, manifest, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (!FALLBACK_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
      await rm(destinationPath, { recursive: true, force: true });
      await this.fallback.materialize(baselineTreePath, destinationPath, manifest, signal);
    }
  }
}
