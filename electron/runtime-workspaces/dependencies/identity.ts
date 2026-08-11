import { createHash } from "node:crypto";
import path from "node:path";
import { DependencyPlanError } from "./errors.js";
import type {
  DependencyInputFile,
  DependencySnapshotEntry,
  DependencySnapshotKey,
} from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function assertSafeDependencyPath(value: string, label: string, allowProjectRoot = false): void {
  if (allowProjectRoot && value === ".") return;
  if (
    value.length === 0
    || value.includes("\0")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new DependencyPlanError(`${label} must be a safe relative POSIX path.`);
  }
}

export function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new DependencyPlanError(`${label} must be a lowercase SHA-256 digest.`);
  }
}

export function dependencyInputsIdentity(files: readonly DependencyInputFile[]): string {
  const ordered = [...files].sort((left, right) => compareUtf8(left.path, right.path));
  const seen = new Set<string>();
  for (const file of ordered) {
    assertSafeDependencyPath(file.path, "Dependency input path");
    assertSha256(file.sha256, `Dependency input ${file.path}`);
    if (
      !Number.isSafeInteger(file.mode)
      || file.mode < 0
      || file.mode > 0o777
      || !Number.isSafeInteger(file.size)
      || file.size < 0
      || seen.has(file.path)
    ) {
      throw new DependencyPlanError("Dependency input inventory is invalid or contains duplicate paths.");
    }
    seen.add(file.path);
  }
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export function dependencySnapshotIdentity(key: DependencySnapshotKey): string {
  assertSafeDependencyPath(key.installRootRelativePath, "Install root", true);
  assertSafeDependencyPath(key.lockfilePath, "Lockfile path");
  for (const [label, digest] of [
    ["lockfileSha256", key.lockfileSha256],
    ["installInputsSha256", key.installInputsSha256],
    ["packageManagerExecutableSha256", key.packageManagerExecutableSha256],
    ["installPolicySha256", key.installPolicySha256],
    ["sourceBaselineIdentity", key.sourceBaselineIdentity],
  ] as const) {
    assertSha256(digest, label);
  }
  if (key.formatVersion !== 1 || !key.packageManagerVersion || !key.materializerVersion) {
    throw new DependencyPlanError("Dependency snapshot key is incomplete.");
  }
  return createHash("sha256").update(JSON.stringify({
    formatVersion: key.formatVersion,
    installInputsSha256: key.installInputsSha256,
    installPolicySha256: key.installPolicySha256,
    installRootRelativePath: key.installRootRelativePath,
    lockfilePath: key.lockfilePath,
    lockfileSha256: key.lockfileSha256,
    materializerVersion: key.materializerVersion,
    packageManager: key.packageManager,
    packageManagerExecutableSha256: key.packageManagerExecutableSha256,
    packageManagerVersion: key.packageManagerVersion,
    sourceBaselineIdentity: key.sourceBaselineIdentity,
    runtime: {
      architecture: key.runtime.architecture,
      libc: key.runtime.libc ?? null,
      modulesAbi: key.runtime.modulesAbi,
      name: key.runtime.name,
      napi: key.runtime.napi ?? null,
      platform: key.runtime.platform,
      version: key.runtime.version,
    },
  })).digest("hex");
}

export function dependencyTreeIdentity(entries: readonly DependencySnapshotEntry[]): string {
  const ordered = [...entries].sort((left, right) => compareUtf8(left.path, right.path));
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export function sha256String(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
