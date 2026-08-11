import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import type { ByteContentIdentity } from "../../src/change-contracts.js";
import {
  assertContainedPath,
  assertManagedPathParents,
} from "../runtime-workspaces/security.js";
import type { WorkspacePaths } from "../runtime-workspaces/types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface FileFingerprint {
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly size: string;
  readonly modifiedNanoseconds: string;
  readonly changedNanoseconds: string;
}

export interface ChangeStoragePaths {
  readonly root: string;
  readonly blobsRoot: string;
  readonly changeSetsRoot: string;
  readonly stagingRoot: string;
}

export interface CapturedBlob {
  readonly identity: ByteContentIdentity;
  readonly mode: number;
}

export interface BlobReadOptions {
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export class UnstableFileReadError extends Error {
  override readonly name = "UnstableFileReadError";

  constructor(readonly filePath: string) {
    super(`File changed while its content was being captured: ${filePath}`);
  }
}

function fingerprint(stat: {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): FileFingerprint {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: Number(stat.mode & 0o777n),
    size: stat.size.toString(),
    modifiedNanoseconds: stat.mtimeNs.toString(),
    changedNanoseconds: stat.ctimeNs.toString(),
  };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return (
    left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.size === right.size
    && left.modifiedNanoseconds === right.modifiedNanoseconds
    && left.changedNanoseconds === right.changedNanoseconds
  );
}

async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const handle = await open(directoryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
}

async function ensureRealDirectory(parent: string, name: string): Promise<string> {
  const candidate = path.join(parent, name);
  try {
    await mkdir(candidate, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Change storage path is not a real directory: ${candidate}`);
  }
  const canonical = await realpath(candidate);
  assertContainedPath(parent, canonical, "Change storage directory");
  return canonical;
}

export async function createChangeStoragePaths(workspacePaths: WorkspacePaths): Promise<ChangeStoragePaths> {
  await assertManagedPathParents(workspacePaths.instanceRoot, path.join(workspacePaths.instanceRoot, "changes"));
  const root = await ensureRealDirectory(workspacePaths.instanceRoot, "changes");
  const blobsRoot = await ensureRealDirectory(root, "blobs");
  const changeSetsRoot = await ensureRealDirectory(root, "change-sets");
  const stagingRoot = await ensureRealDirectory(root, "staging");
  return { root, blobsRoot, changeSetsRoot, stagingRoot };
}

function validateIdentity(identity: ByteContentIdentity): void {
  if (
    identity.hashAlgorithm !== "sha256"
    || !SHA256_PATTERN.test(identity.sha256)
    || !Number.isSafeInteger(identity.byteLength)
    || identity.byteLength < 0
  ) {
    throw new TypeError("Invalid blob identity.");
  }
}

async function resolveContainedFilePath(
  filePath: string,
  contentRoot: string,
  label: string,
): Promise<string> {
  const canonicalRoot = await realpath(path.resolve(contentRoot));
  const absolutePath = path.resolve(filePath);
  const canonicalParent = await realpath(path.dirname(absolutePath));
  const canonicalPath = path.join(canonicalParent, path.basename(absolutePath));

  assertContainedPath(canonicalRoot, canonicalPath, label);
  await assertManagedPathParents(canonicalRoot, canonicalPath);
  const leaf = await lstat(canonicalPath);
  if (leaf.isSymbolicLink()) {
    throw new Error(`${label} is a symbolic link: ${filePath}`);
  }
  return canonicalPath;
}

export class BlobStore {
  private constructor(readonly paths: ChangeStoragePaths) {}

  static async open(workspacePaths: WorkspacePaths): Promise<BlobStore> {
    return new BlobStore(await createChangeStoragePaths(workspacePaths));
  }

  private async blobPath(identity: ByteContentIdentity): Promise<string> {
    validateIdentity(identity);
    const shard = await ensureRealDirectory(this.paths.blobsRoot, identity.sha256.slice(0, 2));
    const blobPath = path.join(shard, identity.sha256);
    assertContainedPath(this.paths.blobsRoot, blobPath, "Blob path");
    return blobPath;
  }

  async captureFile(
    filePath: string,
    canonicalContentRoot: string,
    signal?: AbortSignal,
  ): Promise<CapturedBlob> {
    signal?.throwIfAborted();
    const canonicalPath = await resolveContainedFilePath(filePath, canonicalContentRoot, "Captured file");

    const temporaryPath = path.join(this.paths.stagingRoot, `blob-${randomUUID()}.tmp`);
    const source = await open(canonicalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const destination = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      const before = await source.stat({ bigint: true });
      if (!before.isFile()) throw new Error(`Captured path is not a regular file: ${filePath}`);
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`Captured file is too large to identify safely: ${filePath}`);
      }
      const beforeFingerprint = fingerprint(before);
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let offset = 0;
      while (true) {
        signal?.throwIfAborted();
        const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        let chunkOffset = 0;
        while (chunkOffset < bytesRead) {
          const result = await destination.write(chunk, chunkOffset, bytesRead - chunkOffset, offset + chunkOffset);
          if (result.bytesWritten === 0) throw new Error(`Blob staging write made no progress: ${filePath}`);
          chunkOffset += result.bytesWritten;
        }
        offset += bytesRead;
      }
      await destination.sync();
      const after = await source.stat({ bigint: true });
      if (!sameFingerprint(beforeFingerprint, fingerprint(after)) || offset !== Number(before.size)) {
        throw new UnstableFileReadError(filePath);
      }

      const identity: ByteContentIdentity = {
        hashAlgorithm: "sha256",
        sha256: hash.digest("hex"),
        byteLength: offset,
      };
      await destination.close();
      await source.close();
      await this.installTemporaryBlob(temporaryPath, identity);
      return { identity, mode: beforeFingerprint.mode };
    } catch (error) {
      await Promise.allSettled([source.close(), destination.close()]);
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async inspectFile(
    filePath: string,
    canonicalContentRoot: string,
    signal?: AbortSignal,
  ): Promise<CapturedBlob> {
    signal?.throwIfAborted();
    const canonicalPath = await resolveContainedFilePath(filePath, canonicalContentRoot, "Inspected file");
    const source = await open(canonicalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await source.stat({ bigint: true });
      if (!before.isFile()) throw new Error(`Inspected path is not a regular file: ${filePath}`);
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Inspected file is too large: ${filePath}`);
      const beforeFingerprint = fingerprint(before);
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let offset = 0;
      while (true) {
        signal?.throwIfAborted();
        const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await source.stat({ bigint: true });
      if (!sameFingerprint(beforeFingerprint, fingerprint(after)) || offset !== Number(before.size)) {
        throw new UnstableFileReadError(filePath);
      }
      return {
        identity: { hashAlgorithm: "sha256", sha256: hash.digest("hex"), byteLength: offset },
        mode: beforeFingerprint.mode,
      };
    } finally {
      await source.close();
    }
  }

  async put(bytes: Uint8Array, signal?: AbortSignal): Promise<ByteContentIdentity> {
    signal?.throwIfAborted();
    const immutableBytes = Buffer.from(bytes);
    const identity: ByteContentIdentity = {
      hashAlgorithm: "sha256",
      sha256: createHash("sha256").update(immutableBytes).digest("hex"),
      byteLength: immutableBytes.length,
    };
    const temporaryPath = path.join(this.paths.stagingRoot, `blob-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(immutableBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      signal?.throwIfAborted();
      await this.installTemporaryBlob(temporaryPath, identity);
      return identity;
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private async installTemporaryBlob(temporaryPath: string, identity: ByteContentIdentity): Promise<void> {
    const finalPath = await this.blobPath(identity);
    try {
      await rename(temporaryPath, finalPath);
      await chmod(finalPath, 0o400);
      await syncDirectory(path.dirname(finalPath));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!new Set(["EEXIST", "ENOTEMPTY", "EPERM"]).has(code ?? "")) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      await rm(temporaryPath, { force: true });
    }
    await this.verify(identity);
  }

  async read(identity: ByteContentIdentity, options: BlobReadOptions): Promise<Uint8Array> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
      throw new TypeError("Blob read limit must be a non-negative safe integer.");
    }
    validateIdentity(identity);
    if (identity.byteLength > options.maxBytes) throw new Error(`Blob exceeds read limit: ${identity.sha256}`);
    options.signal?.throwIfAborted();
    const filePath = await this.blobPath(identity);
    const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size !== BigInt(identity.byteLength)) throw new Error(`Blob is invalid: ${identity.sha256}`);
      const bytes = Buffer.allocUnsafe(identity.byteLength);
      const hash = createHash("sha256");
      let offset = 0;
      while (offset < bytes.length) {
        options.signal?.throwIfAborted();
        const { bytesRead } = await handle.read(bytes, offset, Math.min(256 * 1024, bytes.length - offset), offset);
        if (bytesRead === 0) break;
        hash.update(bytes.subarray(offset, offset + bytesRead));
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (
        offset !== bytes.length
        || !sameFingerprint(fingerprint(before), fingerprint(after))
        || hash.digest("hex") !== identity.sha256
      ) throw new Error(`Blob integrity check failed: ${identity.sha256}`);
      return new Uint8Array(bytes);
    } finally {
      await handle.close();
    }
  }

  async verify(identity: ByteContentIdentity, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const filePath = await this.blobPath(identity);
    const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size !== BigInt(identity.byteLength)) {
        throw new Error(`Blob storage entry is invalid: ${identity.sha256}`);
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let offset = 0;
      while (true) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (
        offset !== identity.byteLength
        || !sameFingerprint(fingerprint(before), fingerprint(after))
        || hash.digest("hex") !== identity.sha256
      ) throw new Error(`Blob integrity check failed: ${identity.sha256}`);
    } finally {
      await handle.close();
    }
  }
}
