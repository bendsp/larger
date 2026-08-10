import { createHash } from "node:crypto";
import path from "node:path";
import { realpath } from "node:fs/promises";
import type { ProjectIdentity } from "../../src/project-contracts.js";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

export function projectInstanceKey(projectId: string, canonicalPath: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("Invalid logical project ID");
  if (!path.isAbsolute(canonicalPath)) throw new Error("Canonical project path must be absolute");
  const digest = createHash("sha256")
    .update("larger-project-instance:v1\0", "utf8")
    .update(projectId, "utf8")
    .update("\0", "utf8")
    .update(canonicalPath.normalize("NFC"), "utf8")
    .digest("hex");
  return `instance_${digest}`;
}

export async function createProjectIdentity(projectId: string, projectPath: string): Promise<ProjectIdentity> {
  const canonicalPath = await realpath(path.resolve(projectPath));
  return {
    projectId,
    canonicalPath,
    instanceKey: projectInstanceKey(projectId, canonicalPath),
  };
}

export function sameProjectInstance(left: ProjectIdentity, right: ProjectIdentity): boolean {
  return left.projectId === right.projectId
    && left.instanceKey === right.instanceKey
    && left.canonicalPath === right.canonicalPath;
}
