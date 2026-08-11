import { access, lstat, readdir, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { isInventoryPathExcluded } from "../inventory.js";
import { isContainedPath } from "../security.js";
import { DependencyPlanError, UnsupportedDependencyManagerError } from "./errors.js";
import { hashStableRegularFile, readStableRegularFile } from "./filesystem.js";
import {
  assertSafeDependencyPath,
  dependencyInputsIdentity,
  dependencySnapshotIdentity,
  sha256String,
} from "./identity.js";
import { DirectDependencyCommandRunner, type DependencyCommandRunner } from "./process.js";
import type {
  DependencyInputFile,
  DependencyManagerName,
  DependencyPlanOptions,
  DependencyRuntimeFingerprint,
  ResolvedDependencyPlan,
  SupportedDependencyManager,
} from "./types.js";

const MAX_PACKAGE_JSON_BYTES = 2 * 1024 * 1024;
const ROOT_CONFIGURATION_FILES = new Set([
  ".npmrc",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
  ".yarnrc.yml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
]);

function normalizeWorkingDirectory(value: string | undefined): string {
  const normalized = (value ?? ".").replaceAll("\\", "/");
  if (normalized === ".") return normalized;
  assertSafeDependencyPath(normalized, "Dependency working directory");
  return normalized;
}

async function resolveExecutable(name: string): Promise<string> {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        await access(candidate, fsConstants.X_OK);
        const canonical = await realpath(candidate);
        const stat = await lstat(canonical);
        if (stat.isFile() && !stat.isSymbolicLink()) return canonical;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  throw new DependencyPlanError(`The ${name} executable could not be resolved from PATH.`);
}

function declaredManager(packageJson: Record<string, unknown>): DependencyManagerName | undefined {
  if (typeof packageJson.packageManager !== "string") return undefined;
  const name = packageJson.packageManager.split("@")[0];
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" ? name : undefined;
}

function declaredManagerVersion(packageJson: Record<string, unknown>): string | undefined {
  if (typeof packageJson.packageManager !== "string") return undefined;
  const at = packageJson.packageManager.indexOf("@");
  if (at < 1) return undefined;
  return packageJson.packageManager.slice(at + 1).split("+")[0] || undefined;
}

async function detectedManagers(installRoot: string): Promise<Map<DependencyManagerName, string>> {
  const candidates = new Map<DependencyManagerName, string>();
  for (const [file, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["npm-shrinkwrap.json", "npm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ] as const) {
    try {
      const stat = await lstat(path.join(installRoot, file));
      if (stat.isFile() && !stat.isSymbolicLink() && !candidates.has(manager)) candidates.set(manager, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return candidates;
}

async function collectInstallInputs(
  runtimeRoot: string,
  installRoot: string,
  signal?: AbortSignal,
): Promise<readonly DependencyInputFile[]> {
  const inputs: DependencyInputFile[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    signal?.throwIfAborted();
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const child of children) {
      signal?.throwIfAborted();
      if (isInventoryPathExcluded(relativeDirectory, child.name)) continue;
      const childPath = path.join(directory, child.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (child.isDirectory() && !child.isSymbolicLink()) {
        await visit(childPath, relative);
        continue;
      }
      const insidePatchDirectory = relative.startsWith("patches/")
        || relative.includes("/patches/")
        || relative.startsWith(".yarn/patches/");
      const insideYarnToolchain = relative.startsWith(".yarn/releases/") || relative.startsWith(".yarn/plugins/");
      const relevant = child.name === "package.json"
        || (relativeDirectory === "" && ROOT_CONFIGURATION_FILES.has(child.name))
        || insidePatchDirectory
        || insideYarnToolchain;
      if (!relevant) continue;
      if (!child.isFile() || child.isSymbolicLink()) {
        throw new DependencyPlanError(`Dependency input must be a regular file: ${relative}`);
      }
      const metadata = await hashStableRegularFile(childPath, signal);
      inputs.push({
        path: path.relative(runtimeRoot, childPath).split(path.sep).join("/"),
        mode: metadata.mode,
        size: metadata.size,
        sha256: metadata.sha256,
      });
    }
  }
  await visit(installRoot, "");
  inputs.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return inputs;
}

function runtimeFingerprint(): DependencyRuntimeFingerprint {
  const report = process.platform === "linux" && process.report?.getReport
    ? process.report.getReport() as { header?: { glibcVersionRuntime?: string } }
    : undefined;
  return {
    name: "node",
    version: process.version,
    modulesAbi: process.versions.modules ?? "unknown",
    ...(process.versions.napi ? { napi: process.versions.napi } : {}),
    platform: process.platform,
    architecture: process.arch,
    ...(report ? { libc: String(report.header?.glibcVersionRuntime ?? "unknown") } : {}),
  };
}

function installPolicy(manager: SupportedDependencyManager): string {
  return manager === "npm"
    ? JSON.stringify({ command: "ci", audit: false, fund: false, scripts: "project-policy" })
    : JSON.stringify({
        command: "install",
        frozenLockfile: true,
        packageImportMethod: "clone-or-copy",
        globalVirtualStore: false,
        scripts: "project-policy",
      });
}

export async function resolveDependencyPlan(
  requestedRuntimeRoot: string,
  options: DependencyPlanOptions = {},
  commandRunner: DependencyCommandRunner = new DirectDependencyCommandRunner(),
): Promise<ResolvedDependencyPlan> {
  options.signal?.throwIfAborted();
  const runtimeRoot = await realpath(requestedRuntimeRoot);
  const workingDirectory = normalizeWorkingDirectory(options.workingDirectory);
  const requestedInstallRoot = workingDirectory === "."
    ? runtimeRoot
    : path.join(runtimeRoot, ...workingDirectory.split("/"));
  const installRoot = await realpath(requestedInstallRoot);
  if (!isContainedPath(runtimeRoot, installRoot) || installRoot !== path.resolve(requestedInstallRoot)) {
    throw new DependencyPlanError("Dependency working directory escapes the runtime or traverses a symlink.");
  }
  const packageJsonPath = path.join(installRoot, "package.json");
  const packageJson = JSON.parse((await readStableRegularFile(packageJsonPath, MAX_PACKAGE_JSON_BYTES, options.signal)).toString("utf8")) as unknown;
  if (typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson)) {
    throw new DependencyPlanError("package.json must contain an object.");
  }
  const fromManifest = declaredManager(packageJson as Record<string, unknown>);
  const candidates = await detectedManagers(installRoot);
  const requested = options.packageManager ?? fromManifest;
  if (requested && fromManifest && requested !== fromManifest) {
    throw new DependencyPlanError("The requested package manager conflicts with package.json#packageManager.");
  }
  const candidateNames = [...candidates.keys()];
  const manager = requested ?? (candidateNames.length === 1 ? candidateNames[0] : undefined);
  if (!manager || (!requested && candidateNames.length !== 1)) {
    throw new DependencyPlanError("The dependency package manager is missing or ambiguous.");
  }
  if (manager === "bun") throw new UnsupportedDependencyManagerError("bun", "Bun dependency snapshots are not supported yet.");
  if (manager === "yarn") {
    let yarnConfiguration = "";
    try {
      yarnConfiguration = (await readStableRegularFile(path.join(installRoot, ".yarnrc.yml"), 1024 * 1024, options.signal)).toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (/^\s*nodeLinker\s*:\s*["']?pnp["']?\s*$/m.test(yarnConfiguration)) {
      throw new UnsupportedDependencyManagerError("yarn-pnp", "Yarn Plug'n'Play requires a separate dependency-layout adapter.");
    }
    throw new UnsupportedDependencyManagerError("yarn", "Yarn node_modules snapshots are not supported yet.");
  }
  const lockfileName = manager === "npm"
    ? (candidates.get("npm") === "npm-shrinkwrap.json" ? "npm-shrinkwrap.json" : "package-lock.json")
    : "pnpm-lock.yaml";
  if (!candidates.has(manager)) throw new DependencyPlanError(`${manager} requires ${lockfileName}.`);
  const lockfilePath = path.join(installRoot, lockfileName);
  const lockfile = await hashStableRegularFile(lockfilePath, options.signal);
  const inputFiles = await collectInstallInputs(runtimeRoot, installRoot, options.signal);
  const managerExecutable = await resolveExecutable(manager);
  const [managerExecutableMetadata, managerVersionResult] = await Promise.all([
    hashStableRegularFile(managerExecutable, options.signal),
    commandRunner.run({
      executable: managerExecutable,
      arguments: ["--version"],
      // Version probing must not execute package-manager self-management based
      // on an untrusted project's packageManager field.
      cwd: path.dirname(managerExecutable),
      environment: { PATH: process.env.PATH, HOME: process.env.HOME },
      signal: options.signal,
    }),
  ]);
  const managerVersion = managerVersionResult.stdout.trim();
  if (!/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(managerVersion)) {
    throw new DependencyPlanError(`${manager} returned an invalid version.`);
  }
  const requiredVersion = declaredManagerVersion(packageJson as Record<string, unknown>);
  if (requiredVersion && requiredVersion !== managerVersion) {
    throw new DependencyPlanError(`package.json requires ${manager}@${requiredVersion}, but PATH resolved ${manager}@${managerVersion}.`);
  }
  const installRootRelativePath = path.relative(runtimeRoot, installRoot).split(path.sep).join("/") || ".";
  const policy = installPolicy(manager);
  const key = {
    formatVersion: 1 as const,
    packageManager: manager,
    packageManagerVersion: managerVersion,
    packageManagerExecutableSha256: managerExecutableMetadata.sha256,
    installRootRelativePath,
    lockfilePath: path.relative(runtimeRoot, lockfilePath).split(path.sep).join("/"),
    lockfileSha256: lockfile.sha256,
    installInputsSha256: dependencyInputsIdentity(inputFiles),
    sourceBaselineIdentity: options.sourceBaselineIdentity ?? sha256String("unbound-runtime-source"),
    runtime: runtimeFingerprint(),
    installPolicySha256: sha256String(policy),
    materializerVersion: "dependency-materializer-v1",
  };
  return {
    identity: dependencySnapshotIdentity(key),
    key,
    managerExecutable,
    installRootRelativePath,
    inputFiles,
  };
}
