import { createHash } from "node:crypto";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";

import type {
  ByteContentIdentity,
  ChangeFile,
  FileOperation,
  PossibleRenameHint,
  TextFileChange,
  UnsupportedChangeReason,
  UnsupportedFileChange,
} from "../../src/change-contracts.js";
import {
  isInventoryPathExcluded,
  verifyBaselineTree,
} from "../runtime-workspaces/inventory.js";
import {
  isContainedPath,
  manifestEntryPath,
} from "../runtime-workspaces/security.js";
import type {
  InventoryEntry,
  RuntimeWorkspace,
  WorkspacePaths,
} from "../runtime-workspaces/types.js";
import { BlobStore, UnstableFileReadError, type CapturedBlob } from "./blob-store.js";
import { diffTextFiles } from "./diff-engine.js";
import {
  decodeTextFile,
  DEFAULT_TEXT_DECODE_LIMITS,
  type DecodedTextFile,
} from "./text-codec.js";

type RuntimeEntry =
  | { readonly type: "directory"; readonly mode: number }
  | { readonly type: "file"; readonly capture: CapturedBlob | null; readonly unstable: boolean }
  | { readonly type: "symlink"; readonly mode: number; readonly target: string }
  | { readonly type: "special"; readonly mode: number };

export interface RuntimeChangeScan {
  readonly baselineIdentity: string;
  readonly runtimeId: string;
  readonly files: readonly ChangeFile[];
}

export class RuntimeMutationError extends Error {
  override readonly name = "RuntimeMutationError";
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function modeOf(stat: { mode: number }): number {
  return stat.mode & 0o777;
}

function manifestPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function contentIdentity(entry: InventoryEntry | RuntimeEntry | undefined): ByteContentIdentity | null {
  if (!entry || entry.type !== "file") return null;
  if ("contentSha256" in entry) {
    return { hashAlgorithm: "sha256", sha256: entry.contentSha256, byteLength: entry.size };
  }
  return entry.capture?.identity ?? null;
}

function entryMode(entry: InventoryEntry | RuntimeEntry | undefined): number | null {
  if (!entry) return null;
  return entry.type === "file" && "capture" in entry ? entry.capture?.mode ?? null : entry.mode;
}

function operationFor(baseline: InventoryEntry | undefined, runtime: RuntimeEntry | undefined): FileOperation {
  if (!baseline) return "add";
  if (!runtime) return "delete";
  return "modify";
}

function fileId(
  pathValue: string,
  operation: FileOperation,
  baseline: InventoryEntry | undefined,
  runtime: RuntimeEntry | undefined,
  reason?: UnsupportedChangeReason,
): string {
  const baselineIdentity = contentIdentity(baseline);
  const editedIdentity = contentIdentity(runtime);
  return createHash("sha256").update(JSON.stringify({
    formatVersion: 1,
    path: pathValue,
    operation,
    baseline: baselineIdentity,
    edited: editedIdentity,
    baselineType: baseline?.type ?? null,
    editedType: runtime?.type ?? null,
    baselineMode: baseline?.mode ?? null,
    editedMode: entryMode(runtime),
    reason: reason ?? null,
  })).digest("hex");
}

function identityEquals(left: ByteContentIdentity | null, right: ByteContentIdentity | null): boolean {
  return left?.sha256 === right?.sha256 && left?.byteLength === right?.byteLength;
}

function runtimeEntriesEqual(left: RuntimeEntry, right: RuntimeEntry): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "file" && right.type === "file") {
    if (left.unstable || right.unstable) return left.unstable && right.unstable;
    return left.capture?.mode === right.capture?.mode
      && identityEquals(left.capture?.identity ?? null, right.capture?.identity ?? null);
  }
  if (left.type === "symlink" && right.type === "symlink") {
    return left.mode === right.mode && left.target === right.target;
  }
  return entryMode(left) === entryMode(right);
}

async function observeRuntime(
  runtimeRoot: string,
  blobs: BlobStore,
  signal?: AbortSignal,
): Promise<Map<string, RuntimeEntry>> {
  const entries = new Map<string, RuntimeEntry>();

  async function walk(relativeDirectory: string): Promise<void> {
    signal?.throwIfAborted();
    const directoryPath = relativeDirectory ? manifestEntryPath(runtimeRoot, relativeDirectory) : runtimeRoot;
    const directoryStat = await lstat(directoryPath);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new RuntimeMutationError(`Runtime directory changed during scan: ${relativeDirectory || "."}`);
    }
    const children = (await readdir(directoryPath, { withFileTypes: true })).sort((left, right) =>
      compareUtf8(left.name, right.name),
    );
    for (const child of children) {
      signal?.throwIfAborted();
      if (isInventoryPathExcluded(relativeDirectory, child.name)) continue;
      const relativePath = manifestPath(path.join(relativeDirectory, child.name));
      const entryPath = manifestEntryPath(runtimeRoot, relativePath);
      const stat = await lstat(entryPath);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        entries.set(relativePath, { type: "directory", mode: modeOf(stat) });
        await walk(relativePath);
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        try {
          entries.set(relativePath, {
            type: "file",
            capture: await blobs.inspectFile(entryPath, runtimeRoot, signal),
            unstable: false,
          });
        } catch (error) {
          if (!(error instanceof UnstableFileReadError)) throw error;
          entries.set(relativePath, { type: "file", capture: null, unstable: true });
        }
      } else if (stat.isSymbolicLink()) {
        entries.set(relativePath, { type: "symlink", mode: modeOf(stat), target: await readlink(entryPath) });
      } else {
        entries.set(relativePath, { type: "special", mode: modeOf(stat) });
      }
    }
  }

  await walk("");
  return entries;
}

function assertStableObservation(
  first: ReadonlyMap<string, RuntimeEntry>,
  second: ReadonlyMap<string, RuntimeEntry>,
): void {
  const firstPaths = [...first.keys()].sort(compareUtf8);
  const secondPaths = [...second.keys()].sort(compareUtf8);
  if (JSON.stringify(firstPaths) !== JSON.stringify(secondPaths)) {
    throw new RuntimeMutationError("Runtime tree changed during scan.");
  }
  for (const pathValue of firstPaths) {
    const left = first.get(pathValue);
    const right = second.get(pathValue);
    if (!left || !right) throw new RuntimeMutationError("Runtime tree changed during scan.");
    if (left.type === "file" && right.type === "file" && (left.unstable || right.unstable)) continue;
    if (!runtimeEntriesEqual(left, right)) throw new RuntimeMutationError(`Runtime entry changed during scan: ${pathValue}`);
  }
}

function unsupported(
  pathValue: string,
  operation: FileOperation,
  baselineEntry: InventoryEntry | undefined,
  runtimeEntry: RuntimeEntry | undefined,
  reason: UnsupportedChangeReason,
): UnsupportedFileChange {
  return {
    kind: "unsupported",
    id: fileId(pathValue, operation, baselineEntry, runtimeEntry, reason),
    path: pathValue,
    operation,
    reason,
    baseline: contentIdentity(baselineEntry),
    edited: contentIdentity(runtimeEntry),
    possibleRename: null,
  };
}

function emptyTextFile(): DecodedTextFile {
  const decoded = decodeTextFile(new Uint8Array());
  if (!decoded.ok) throw new Error("The empty UTF-8 text sentinel could not be decoded.");
  return decoded.value;
}

function withRename(file: ChangeFile, otherPath: string): ChangeFile {
  const hint: PossibleRenameHint = { kind: "possible-rename", otherPath, confidence: "exact-content" };
  return { ...file, possibleRename: hint };
}

function addUniqueRenameHints(files: readonly ChangeFile[]): readonly ChangeFile[] {
  const additions = new Map<string, ChangeFile[]>();
  const deletions = new Map<string, ChangeFile[]>();
  for (const file of files) {
    const identity = file.operation === "add" ? file.edited : file.operation === "delete" ? file.baseline : null;
    if (!identity) continue;
    const key = `${identity.sha256}:${identity.byteLength}`;
    const target = file.operation === "add" ? additions : deletions;
    const group = target.get(key) ?? [];
    group.push(file);
    target.set(key, group);
  }
  const hints = new Map<string, string>();
  for (const [key, added] of additions) {
    const deleted = deletions.get(key);
    if (added.length === 1 && deleted?.length === 1) {
      const addition = added[0];
      const deletion = deleted[0];
      if (addition && deletion) {
        hints.set(addition.id, deletion.path);
        hints.set(deletion.id, addition.path);
      }
    }
  }
  return Object.freeze(files.map((file) => hints.has(file.id) ? withRename(file, hints.get(file.id)!) : file));
}

export class RuntimeChangeScanner {
  private constructor(
    readonly workspacePaths: WorkspacePaths,
    readonly blobs: BlobStore,
  ) {}

  static async open(workspacePaths: WorkspacePaths, blobs?: BlobStore): Promise<RuntimeChangeScanner> {
    return new RuntimeChangeScanner(workspacePaths, blobs ?? await BlobStore.open(workspacePaths));
  }

  async scan(workspace: RuntimeWorkspace, signal?: AbortSignal): Promise<RuntimeChangeScan> {
    signal?.throwIfAborted();
    if (workspace.baselineIdentity !== workspace.manifest.identity) throw new Error("Workspace baseline identity is inconsistent.");
    const expectedBaselinePath = path.join(this.workspacePaths.baselinesRoot, workspace.baselineIdentity);
    const expectedRuntimePath = path.join(this.workspacePaths.runtimesRoot, workspace.runtimeId);
    if (path.resolve(workspace.baselinePath) !== expectedBaselinePath || path.resolve(workspace.runtimePath) !== expectedRuntimePath) {
      throw new Error("Workspace paths do not belong to the authorized local instance.");
    }
    const [canonicalBaseline, canonicalRuntime] = await Promise.all([
      realpath(workspace.baselinePath),
      realpath(workspace.runtimePath),
    ]);
    if (
      canonicalBaseline !== expectedBaselinePath
      || canonicalRuntime !== expectedRuntimePath
      || !isContainedPath(this.workspacePaths.instanceRoot, canonicalBaseline)
      || !isContainedPath(this.workspacePaths.instanceRoot, canonicalRuntime)
    ) throw new Error("Workspace path escapes its local instance.");
    await verifyBaselineTree(path.join(canonicalBaseline, "tree"), workspace.manifest, signal);

    const firstObservation = await observeRuntime(canonicalRuntime, this.blobs, signal);
    const secondObservation = await observeRuntime(canonicalRuntime, this.blobs, signal);
    assertStableObservation(firstObservation, secondObservation);
    const baselineByPath = new Map(workspace.manifest.entries.map((entry) => [entry.path, entry]));
    const paths = new Set([...baselineByPath.keys(), ...firstObservation.keys()]);
    const files: ChangeFile[] = [];

    for (const pathValue of [...paths].sort(compareUtf8)) {
      signal?.throwIfAborted();
      const baselineEntry = baselineByPath.get(pathValue);
      const runtimeEntry = firstObservation.get(pathValue);
      if (baselineEntry?.type === "directory" && runtimeEntry?.type === "directory") continue;
      if (!baselineEntry && runtimeEntry?.type === "directory") continue;
      if (baselineEntry?.type === "directory" && !runtimeEntry) continue;
      if (
        baselineEntry?.type === "symlink"
        && runtimeEntry?.type === "symlink"
        && baselineEntry.materializedTarget === runtimeEntry.target
        && baselineEntry.mode === runtimeEntry.mode
      ) continue;
      if (
        baselineEntry?.type === "file"
        && runtimeEntry?.type === "file"
        && !runtimeEntry.unstable
        && identityEquals(contentIdentity(baselineEntry), contentIdentity(runtimeEntry))
        && baselineEntry.mode === runtimeEntry.capture?.mode
      ) continue;

      const operation = operationFor(baselineEntry, runtimeEntry);
      if (runtimeEntry?.type === "file" && runtimeEntry.unstable) {
        files.push(unsupported(pathValue, operation, baselineEntry, runtimeEntry, "unstable-read"));
        continue;
      }
      if (baselineEntry?.type === "symlink" || runtimeEntry?.type === "symlink") {
        files.push(unsupported(pathValue, operation, baselineEntry, runtimeEntry, "symlink"));
        continue;
      }
      if ((baselineEntry && baselineEntry.type !== "file") || (runtimeEntry && runtimeEntry.type !== "file")) {
        files.push(unsupported(pathValue, operation, baselineEntry, runtimeEntry, "special-file"));
        continue;
      }
      if (
        baselineEntry?.type === "file"
        && runtimeEntry?.type === "file"
        && baselineEntry.mode !== runtimeEntry.capture?.mode
      ) {
        await this.persistChangedFiles(pathValue, baselineEntry, runtimeEntry, canonicalBaseline, canonicalRuntime, signal);
        files.push(unsupported(pathValue, operation, baselineEntry, runtimeEntry, "mode-change"));
        continue;
      }

      await this.persistChangedFiles(pathValue, baselineEntry, runtimeEntry, canonicalBaseline, canonicalRuntime, signal);
      const baselineDecoded = baselineEntry?.type === "file"
        ? await this.decode(contentIdentity(baselineEntry)!, signal)
        : { ok: true as const, value: emptyTextFile() };
      const editedDecoded = runtimeEntry?.type === "file"
        ? await this.decode(contentIdentity(runtimeEntry)!, signal)
        : { ok: true as const, value: emptyTextFile() };
      if (!baselineDecoded.ok || !editedDecoded.ok) {
        const reason = !editedDecoded.ok ? editedDecoded.reason : !baselineDecoded.ok ? baselineDecoded.reason : "unsupported-encoding";
        files.push(unsupported(pathValue, operation, baselineEntry, runtimeEntry, reason));
        continue;
      }
      const diff = diffTextFiles(pathValue, baselineDecoded.value, editedDecoded.value);
      if (!diff.ok) {
        files.push(unsupported(pathValue, operation, baselineEntry, runtimeEntry, diff.reason));
        continue;
      }
      const textFile: TextFileChange = {
        kind: "text",
        id: fileId(pathValue, operation, baselineEntry, runtimeEntry),
        path: pathValue,
        operation,
        baseline: baselineEntry ? baselineDecoded.value.metadata : null,
        edited: runtimeEntry ? editedDecoded.value.metadata : null,
        hunks: diff.value.hunks,
        possibleRename: null,
      };
      files.push(textFile);
    }

    return Object.freeze({
      baselineIdentity: workspace.baselineIdentity,
      runtimeId: workspace.runtimeId,
      files: addUniqueRenameHints(files),
    });
  }

  private async persistChangedFiles(
    pathValue: string,
    baselineEntry: InventoryEntry | undefined,
    runtimeEntry: RuntimeEntry | undefined,
    canonicalBaseline: string,
    canonicalRuntime: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (baselineEntry?.type === "file") {
      const expected = contentIdentity(baselineEntry)!;
      const captured = await this.blobs.captureFile(
        manifestEntryPath(path.join(canonicalBaseline, "tree"), pathValue),
        path.join(canonicalBaseline, "tree"),
        signal,
      );
      if (!identityEquals(expected, captured.identity)) throw new Error(`Baseline content changed: ${pathValue}`);
    }
    if (runtimeEntry?.type === "file" && runtimeEntry.capture) {
      const captured = await this.blobs.captureFile(
        manifestEntryPath(canonicalRuntime, pathValue),
        canonicalRuntime,
        signal,
      );
      if (!identityEquals(runtimeEntry.capture.identity, captured.identity) || runtimeEntry.capture.mode !== captured.mode) {
        throw new RuntimeMutationError(`Runtime file changed before durable capture: ${pathValue}`);
      }
    }
  }

  private async decode(identity: ByteContentIdentity, signal?: AbortSignal) {
    if (identity.byteLength > DEFAULT_TEXT_DECODE_LIMITS.maxBytes) {
      return { ok: false as const, reason: "file-too-large" as const, identity };
    }
    const bytes = await this.blobs.read(identity, { maxBytes: DEFAULT_TEXT_DECODE_LIMITS.maxBytes, signal });
    return decodeTextFile(bytes);
  }
}
