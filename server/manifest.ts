import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectManifest } from "../src/contracts.js";

export const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
export const MANIFEST_PATH = path.join(STUDIO_ROOT, "larger.project.json");

export async function readManifest(): Promise<ProjectManifest> {
  const raw = await readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw) as Partial<ProjectManifest>;

  if (manifest.schemaVersion !== 1 || !manifest.project) {
    throw new Error("larger.project.json must use schemaVersion 1");
  }

  const { project } = manifest;
  const command = project.dev?.command;
  const entryRoute = project.entryRoute;
  if (
    typeof project.name !== "string" ||
    project.name.trim().length === 0 ||
    typeof project.root !== "string" ||
    project.root.trim().length === 0 ||
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((value) => typeof value === "string" && value.trim().length > 0) ||
    !["127.0.0.1", "localhost"].includes(project.dev?.host ?? "") ||
    !Number.isInteger(project.dev?.preferredPort) ||
    (project.dev?.preferredPort ?? 0) < 1024 ||
    (project.dev?.preferredPort ?? 0) > 65_535 ||
    (entryRoute !== undefined &&
      (typeof entryRoute !== "string" || !entryRoute.startsWith("/") || entryRoute.startsWith("//"))) ||
    typeof project.engine?.adapter !== "string" ||
    project.engine.adapter.trim().length === 0 ||
    project.engine.mode !== "sandbox"
  ) {
    throw new Error("larger.project.json is missing a required project field");
  }

  return manifest as ProjectManifest;
}

export async function resolveSourceRoot(manifest: ProjectManifest): Promise<string> {
  const requestedRoot = path.resolve(STUDIO_ROOT, manifest.project.root);
  const [sourceRoot, studioRoot, homeRoot] = await Promise.all([
    realpath(requestedRoot),
    realpath(STUDIO_ROOT),
    realpath(os.homedir()),
  ]);
  if (sourceRoot === path.parse(sourceRoot).root || sourceRoot === homeRoot) {
    throw new Error("Project root cannot be the filesystem root or home directory");
  }
  if (studioRoot.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error("Project root cannot contain the Larger repository");
  }
  return sourceRoot;
}
