import { createHash } from "node:crypto";
import type { DependencyCacheDescriptor, DependencyCacheKey } from "./types.js";

function canonicalKey(key: DependencyCacheKey): string {
  return JSON.stringify({
    architecture: key.architecture,
    lockfileSha256: key.lockfileSha256,
    packageManager: key.packageManager,
    platform: key.platform,
    runtime: key.runtime,
    toolchainVersion: key.toolchainVersion,
  });
}

export function dependencyCacheIdentity(key: DependencyCacheKey): string {
  if (!/^[a-f0-9]{64}$/.test(key.lockfileSha256)) {
    throw new TypeError("lockfileSha256 must be a lowercase SHA-256 digest.");
  }
  return createHash("sha256").update(canonicalKey(key)).digest("hex");
}

export function describeDependencyCache(key: DependencyCacheKey): DependencyCacheDescriptor {
  return {
    identity: dependencyCacheIdentity(key),
    key: { ...key },
    sharing: "immutable-read-only",
    runtimeNodeModules: "private-writable",
  };
}
