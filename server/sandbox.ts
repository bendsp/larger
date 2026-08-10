import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { SandboxChange } from "../src/contracts.js";

const EXCLUDED_ROOT_ENTRIES = new Set([".git", "dist", "node_modules", "out"]);
const DIFF_EXTENSIONS = new Set([".css", ".js", ".jsx", ".json", ".md", ".mdx", ".ts", ".tsx"]);

function isExcluded(relativePath: string): boolean {
  const [rootEntry] = relativePath.split(path.sep);
  return EXCLUDED_ROOT_ENTRIES.has(rootEntry) || rootEntry.startsWith(".next");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectSymlinks(root: string, excludeRuntimeDirectories: boolean): Promise<Set<string>> {
  const symlinks = new Set<string>();
  const pending = [""];
  while (pending.length > 0) {
    const relativeDirectory = pending.shift() ?? "";
    let entries;
    try {
      entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = path.join(relativeDirectory, entry.name);
      if (excludeRuntimeDirectories && isExcluded(relative)) continue;
      const absolute = path.join(root, relative);
      if (entry.isSymbolicLink()) {
        symlinks.add(absolute);
      } else if (entry.isDirectory()) {
        pending.push(relative);
      }
    }
  }
  return symlinks;
}

async function assertSymlinksStayInside(root: string): Promise<void> {
  const symlinks = await collectSymlinks(root, false);
  for (const symlinkPath of symlinks) {
    const target = await readlink(symlinkPath);
    const resolvedTarget = path.resolve(path.dirname(symlinkPath), target);
    if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Dependency symlink escapes the sandbox: ${path.relative(root, symlinkPath)}`);
    }
  }
}

export type SandboxBaseline = Map<string, string>;

async function resolveSafeRuntimeRoot(runtimeRoot: string, runtimeAnchor: string): Promise<string> {
  const resolvedAnchor = path.resolve(runtimeAnchor);
  const resolvedRuntime = path.resolve(runtimeRoot);
  const relative = path.relative(resolvedAnchor, resolvedRuntime);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Sandbox runtime must be a child of its trusted runtime anchor");
  }

  const canonicalAnchor = await realpath(resolvedAnchor);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = canonicalAnchor;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`Sandbox runtime path contains a symlink: ${path.relative(canonicalAnchor, current)}`);
      }
      if (!info.isDirectory()) {
        throw new Error(`Sandbox runtime path contains a non-directory: ${path.relative(canonicalAnchor, current)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return path.join(canonicalAnchor, ...segments);
}

export async function createSandbox(
  sourceRoot: string,
  runtimeRoot: string,
  runtimeAnchor: string,
): Promise<SandboxBaseline> {
  const resolvedSource = await realpath(sourceRoot);
  const resolvedRuntime = await resolveSafeRuntimeRoot(runtimeRoot, runtimeAnchor);
  if (
    resolvedSource === resolvedRuntime ||
    resolvedSource.startsWith(`${resolvedRuntime}${path.sep}`) ||
    resolvedRuntime.startsWith(`${resolvedSource}${path.sep}`)
  ) {
    throw new Error("Sandbox runtime must be separate from the source project");
  }

  const sourceSymlinks = await collectSymlinks(resolvedSource, true);
  await rm(resolvedRuntime, { recursive: true, force: true });
  await mkdir(path.dirname(resolvedRuntime), { recursive: true });
  await cp(resolvedSource, resolvedRuntime, {
    recursive: true,
    preserveTimestamps: true,
    filter: (source) => {
      const relative = path.relative(resolvedSource, source);
      return relative === "" || (!isExcluded(relative) && !sourceSymlinks.has(path.resolve(source)));
    },
  });

  const sourceModules = path.join(resolvedSource, "node_modules");
  if (!(await pathExists(sourceModules))) {
    throw new Error(`Dependencies are not installed in ${resolvedSource}`);
  }

  const runtimeModules = path.join(resolvedRuntime, "node_modules");
  await cp(sourceModules, runtimeModules, {
    recursive: true,
    preserveTimestamps: true,
    dereference: false,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
  await assertSymlinksStayInside(runtimeModules);
  return await collectDiffableFiles(resolvedRuntime);
}

async function collectDiffableFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const pending = [""];

  while (pending.length > 0) {
    const relativeDirectory = pending.shift() ?? "";
    let entries;
    try {
      entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const relative = path.join(relativeDirectory, entry.name);
      if (isExcluded(relative)) continue;
      if (entry.isDirectory()) {
        pending.push(relative);
      } else if (entry.isFile() && DIFF_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const content = await readFile(path.join(root, relative));
        const digest = createHash("sha1").update(content).digest("hex");
        files.set(relative.split(path.sep).join("/"), digest);
      }
    }
  }

  return files;
}

export async function inspectSandboxChanges(
  baselineFiles: SandboxBaseline,
  runtimeRoot: string,
): Promise<SandboxChange[]> {
  if (!(await pathExists(runtimeRoot))) return [];
  const runtimeFiles = await collectDiffableFiles(runtimeRoot);
  const allFiles = new Set([...baselineFiles.keys(), ...runtimeFiles.keys()]);
  const changes: SandboxChange[] = [];

  for (const file of Array.from(allFiles).sort((a, b) => a.localeCompare(b))) {
    const sourceDigest = baselineFiles.get(file);
    const runtimeDigest = runtimeFiles.get(file);
    if (sourceDigest === runtimeDigest) continue;
    changes.push({
      file,
      status: sourceDigest === undefined ? "added" : runtimeDigest === undefined ? "deleted" : "modified",
    });
  }

  return changes;
}
