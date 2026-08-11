import { randomUUID } from "node:crypto";
import path from "node:path";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import type { ProjectDetection, ProjectManifest } from "../../src/project-contracts.js";
import { PROJECT_MANIFEST_SCHEMA_URL, PROJECT_MANIFEST_VERSION } from "../../src/project-contracts.js";
import { normalizeProjectManifest, serializeProjectManifest } from "./project-manifest.js";

const MANIFEST_DIRECTORY = ".larger";
const MANIFEST_FILE = "project.json";
const PROJECT_GITIGNORE = "runtime/\ncache/\nlogs/\n";

export interface ProjectWriteOptions {
  signal?: AbortSignal;
  shouldPublish?: () => boolean;
}

function assertMayPublish(options: ProjectWriteOptions): void {
  options.signal?.throwIfAborted();
  if (options.shouldPublish && !options.shouldPublish()) {
    throw new DOMException("The project operation was superseded", "AbortError");
  }
}

function detectedValue<T>(detection: { status: string; value?: T }, fallback: T): T {
  return detection.status === "detected" && detection.value !== undefined ? detection.value : fallback;
}

export function suggestProjectManifest(
  projectPath: string,
  detection: ProjectDetection,
  createId: () => string = randomUUID,
): ProjectManifest {
  const packageManager = detectedValue(detection.packageManager, "npm");
  const scripts = detectedValue(detection.scripts, {} as Record<string, string>);
  const scriptName = scripts.dev ? "dev" : scripts.start ? "start" : "dev";
  const command = packageManager === "npm"
    ? ["npm", "run", scriptName]
    : [packageManager, scriptName];
  const framework = detectedValue(detection.framework, null);
  const runtimeAdapter = framework === "nextjs"
    ? "next"
    : framework === "vite"
      ? "vite"
      : framework === "cra"
        ? "react-scripts"
        : "auto";
  const entryRoute = detectedValue(detection.entryRoute, "/");
  return {
    $schema: PROJECT_MANIFEST_SCHEMA_URL,
    schemaVersion: PROJECT_MANIFEST_VERSION,
    projectId: `project-${createId()}`,
    name: path.basename(projectPath),
    defaultRuntimeProfile: "dev",
    runtimeProfiles: {
      dev: {
        command,
        workingDirectory: ".",
        dependencyRoot: ".",
        host: "127.0.0.1",
        preferredPort: detectedValue(detection.preferredPort, 3000),
        readiness: { path: entryRoute, timeoutMs: 60_000 },
        entryRoute,
        environment: { literals: {}, inherit: [], secrets: {} },
        runtimeAdapter,
        editorAdapter: "react-rewrite",
      },
    },
  };
}

async function missing(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw cause;
  }
}

async function publishNewFile(target: string, contents: string, options: ProjectWriteOptions = {}): Promise<void> {
  assertMayPublish(options);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    assertMayPublish(options);
    await link(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some supported filesystems do not allow directory handles to be synced.
  }
}

export async function initializeProject(
  projectPath: string,
  input: unknown,
  options: ProjectWriteOptions = {},
): Promise<ProjectManifest> {
  assertMayPublish(options);
  const canonicalRoot = await realpath(path.resolve(projectPath));
  const manifest = normalizeProjectManifest(input);
  const metadataDirectory = path.join(canonicalRoot, MANIFEST_DIRECTORY);
  const existingMetadata = await lstat(metadataDirectory).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (existingMetadata?.isSymbolicLink()) throw new Error("The .larger directory must not be a symbolic link");
  if (existingMetadata && !existingMetadata.isDirectory()) throw new Error("The .larger path must be a directory");
  await mkdir(metadataDirectory, { recursive: true, mode: 0o700 });
  if (await realpath(metadataDirectory) !== metadataDirectory) {
    throw new Error("The .larger directory escaped the canonical project root");
  }

  const manifestPath = path.join(metadataDirectory, MANIFEST_FILE);
  if (!(await missing(manifestPath))) throw new Error("This repository is already initialized for Larger");

  const ignorePath = path.join(metadataDirectory, ".gitignore");
  if (await missing(ignorePath)) {
    try {
      await publishNewFile(ignorePath, PROJECT_GITIGNORE, options);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
  }
  if (await realpath(metadataDirectory) !== metadataDirectory) {
    throw new Error("The .larger directory changed during initialization");
  }
  await publishNewFile(manifestPath, serializeProjectManifest(manifest), options);
  return manifest;
}

export async function updateProjectManifest(
  projectPath: string,
  input: unknown,
  options: ProjectWriteOptions = {},
): Promise<ProjectManifest> {
  assertMayPublish(options);
  const canonicalRoot = await realpath(path.resolve(projectPath));
  const manifest = normalizeProjectManifest(input);
  const metadataDirectory = path.join(canonicalRoot, MANIFEST_DIRECTORY);
  if (await realpath(metadataDirectory) !== metadataDirectory) {
    throw new Error("The .larger directory escaped the canonical project root");
  }
  const manifestPath = path.join(metadataDirectory, MANIFEST_FILE);
  const existing = await lstat(manifestPath);
  if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("The project manifest must be a regular file");

  const temporary = path.join(metadataDirectory, `.${MANIFEST_FILE}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(serializeProjectManifest(manifest), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (await realpath(metadataDirectory) !== metadataDirectory) {
      throw new Error("The .larger directory changed while saving the project manifest");
    }
    const current = await lstat(manifestPath);
    if (!current.isFile() || current.isSymbolicLink()) throw new Error("The project manifest changed while it was being saved");
    assertMayPublish(options);
    await rename(temporary, manifestPath);
    await syncDirectory(metadataDirectory);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return manifest;
}
