import { lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { prepareDesktopPaths, type DesktopPaths } from "./desktop-paths.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const WORKSPACE_STAGING = new RegExp(`^(?:reset-)?${UUID}$`, "i");
const BLOB_STAGING = new RegExp(`^blob-${UUID}\\.tmp$`, "i");
const DEPENDENCY_STAGING = new RegExp(`^operation-([1-9][0-9]*)-${UUID}$`, "i");

export interface DesktopRecoveryParticipant {
  readonly id: string;
  recover(signal?: AbortSignal): Promise<void>;
}

export type DesktopRecoveryEntry =
  | { readonly kind: "participant"; readonly id: string; readonly status: "recovered" | "failed"; readonly message?: string }
  | { readonly kind: "staging"; readonly path: string; readonly status: "removed" | "preserved"; readonly reason?: string };

export interface DesktopRecoveryReport {
  readonly status: "complete" | "incomplete";
  readonly entries: readonly DesktopRecoveryEntry[];
}

export interface DesktopRecoveryCoordinatorOptions {
  readonly userDataPath: string;
  readonly participants?: readonly DesktopRecoveryParticipant[];
  readonly isProcessAlive?: (pid: number) => boolean;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function childrenOrEmpty(directory: string): Promise<readonly import("node:fs").Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
}

async function realDirectoryOrMissing(
  parent: string,
  segments: readonly string[],
  entries: DesktopRecoveryEntry[],
): Promise<string | null> {
  let cursor = parent;
  for (const segment of segments) {
    const candidate = path.join(cursor, segment);
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      entries.push({ kind: "staging", path: candidate, status: "preserved", reason: "unsafe-managed-parent" });
      return null;
    }
    const canonical = await realpath(candidate);
    if (!contained(cursor, canonical)) {
      entries.push({ kind: "staging", path: candidate, status: "preserved", reason: "managed-parent-escape" });
      return null;
    }
    cursor = canonical;
  }
  return cursor;
}

function contained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function removeRecognized(
  parent: string,
  name: string,
  expected: "file" | "directory",
  entries: DesktopRecoveryEntry[],
): Promise<void> {
  const candidate = path.join(parent, name);
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink() || (expected === "file" ? !metadata.isFile() : !metadata.isDirectory())) {
    entries.push({ kind: "staging", path: candidate, status: "preserved", reason: "unexpected-file-type" });
    return;
  }
  const canonical = await realpath(candidate);
  if (!contained(parent, canonical)) {
    entries.push({ kind: "staging", path: candidate, status: "preserved", reason: "canonical-path-escape" });
    return;
  }
  await rm(candidate, { recursive: expected === "directory", force: false });
  entries.push({ kind: "staging", path: candidate, status: "removed" });
}

async function recoverInstanceStaging(
  paths: DesktopPaths,
  isProcessAlive: (pid: number) => boolean,
  signal: AbortSignal | undefined,
  entries: DesktopRecoveryEntry[],
): Promise<void> {
  const instancesRoot = await realDirectoryOrMissing(paths.runtimeWorkspacesRoot, ["instances"], entries);
  if (!instancesRoot) return;
  for (const instance of await childrenOrEmpty(instancesRoot)) {
    signal?.throwIfAborted();
    const instancePath = path.join(instancesRoot, instance.name);
    if (!instance.isDirectory() || instance.isSymbolicLink()) {
      entries.push({ kind: "staging", path: instancePath, status: "preserved", reason: "unexpected-instance-type" });
      continue;
    }
    const canonicalInstance = await realpath(instancePath);
    if (!contained(instancesRoot, canonicalInstance)) {
      entries.push({ kind: "staging", path: instancePath, status: "preserved", reason: "instance-path-escape" });
      continue;
    }

    const workspaceStaging = await realDirectoryOrMissing(canonicalInstance, ["staging"], entries);
    if (workspaceStaging) {
      for (const child of await childrenOrEmpty(workspaceStaging)) {
        signal?.throwIfAborted();
        if (!WORKSPACE_STAGING.test(child.name)) {
          entries.push({ kind: "staging", path: path.join(workspaceStaging, child.name), status: "preserved", reason: "unrecognized-name" });
          continue;
        }
        await removeRecognized(workspaceStaging, child.name, "directory", entries);
      }
    }

    const changeStaging = await realDirectoryOrMissing(canonicalInstance, ["changes", "staging"], entries);
    if (changeStaging) {
      for (const child of await childrenOrEmpty(changeStaging)) {
        signal?.throwIfAborted();
        if (!BLOB_STAGING.test(child.name)) {
          entries.push({ kind: "staging", path: path.join(changeStaging, child.name), status: "preserved", reason: "unrecognized-name" });
          continue;
        }
        await removeRecognized(changeStaging, child.name, "file", entries);
      }
    }

    const dependencyStaging = await realDirectoryOrMissing(canonicalInstance, ["dependencies", "staging"], entries);
    if (dependencyStaging) {
      for (const child of await childrenOrEmpty(dependencyStaging)) {
        signal?.throwIfAborted();
        const match = DEPENDENCY_STAGING.exec(child.name);
        if (!match) {
          entries.push({ kind: "staging", path: path.join(dependencyStaging, child.name), status: "preserved", reason: "unrecognized-name" });
          continue;
        }
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || isProcessAlive(pid)) {
          entries.push({ kind: "staging", path: path.join(dependencyStaging, child.name), status: "preserved", reason: "owner-is-live-or-ambiguous" });
          continue;
        }
        await removeRecognized(dependencyStaging, child.name, "directory", entries);
      }
    }
  }
}

export class DesktopRecoveryCoordinator {
  private readonly participants: readonly DesktopRecoveryParticipant[];
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(private readonly options: DesktopRecoveryCoordinatorOptions) {
    this.participants = options.participants ?? [];
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    const identifiers = new Set<string>();
    for (const participant of this.participants) {
      if (!EVENT_ID.test(participant.id) || identifiers.has(participant.id)) {
        throw new TypeError("Desktop recovery participant identifiers must be unique machine-readable names.");
      }
      identifiers.add(participant.id);
    }
  }

  async recover(signal?: AbortSignal): Promise<DesktopRecoveryReport> {
    const entries: DesktopRecoveryEntry[] = [];
    let incomplete = false;
    for (const participant of this.participants) {
      signal?.throwIfAborted();
      try {
        await participant.recover(signal);
        entries.push({ kind: "participant", id: participant.id, status: "recovered" });
      } catch (cause) {
        incomplete = true;
        entries.push({
          kind: "participant",
          id: participant.id,
          status: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    const paths = await prepareDesktopPaths(this.options.userDataPath);
    await recoverInstanceStaging(paths, this.isProcessAlive, signal, entries);
    incomplete ||= entries.some((entry) => entry.status === "preserved" || entry.status === "failed");
    return { status: incomplete ? "incomplete" : "complete", entries };
  }
}

const EVENT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
