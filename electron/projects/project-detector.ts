import path from "node:path";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import type {
  DetectedFramework,
  DetectedPackageManager,
  Detection,
  ProjectDetection,
} from "../../src/project-contracts.js";

const MAX_INSPECTION_FILE_BYTES = 1_000_000;

interface FileRead {
  path: string;
  text: string;
}

interface FileReadDeferred {
  path: string;
  reason: "oversized";
}

type KnownFileRead = FileRead | FileReadDeferred;

interface PackageJson {
  packageManager?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  workspaces?: unknown;
}

function assertContained(root: string, target: string, relativePath: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Project detector refused ${relativePath}: resolved path escapes the project root`);
  }
}

async function resolveKnownPath(root: string, relativePath: string, signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted();
  const requestedPath = path.join(root, relativePath);
  try {
    await lstat(requestedPath);
    signal.throwIfAborted();
    const resolvedPath = await realpath(requestedPath);
    signal.throwIfAborted();
    assertContained(root, resolvedPath, relativePath);
    return resolvedPath;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT" || (cause as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw cause;
  }
}

function notDetected<T>(evidence: string[] = []): Detection<T> {
  return { status: "not-detected", evidence };
}

function detected<T>(value: T, evidence: string[]): Detection<T> {
  return { status: "detected", value, evidence };
}

function ambiguous<T>(candidates: T[], evidence: string[]): Detection<T> {
  return { status: "ambiguous", candidates, evidence };
}

function deferred<T>(reason: string, evidence: string[]): Detection<T> {
  return { status: "deferred", reason, evidence };
}

async function readKnownFile(root: string, relativePath: string, signal: AbortSignal): Promise<KnownFileRead | null> {
  const resolvedPath = await resolveKnownPath(root, relativePath, signal);
  if (!resolvedPath) return null;
  try {
    const metadata = await stat(resolvedPath);
    signal.throwIfAborted();
    if (!metadata.isFile()) return null;
    if (metadata.size > MAX_INSPECTION_FILE_BYTES) return { path: relativePath, reason: "oversized" };
    const text = await readFile(resolvedPath, "utf8");
    signal.throwIfAborted();
    const confirmedPath = await resolveKnownPath(root, relativePath, signal);
    if (confirmedPath !== resolvedPath) throw new Error(`Project detector refused ${relativePath}: path changed during inspection`);
    return { path: relativePath, text };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT" || (cause as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw cause;
  }
}

async function fileKind(root: string, relativePath: string, signal: AbortSignal): Promise<"file" | "directory" | null> {
  const resolvedPath = await resolveKnownPath(root, relativePath, signal);
  if (!resolvedPath) return null;
  try {
    const metadata = await stat(resolvedPath);
    signal.throwIfAborted();
    const confirmedPath = await resolveKnownPath(root, relativePath, signal);
    if (confirmedPath !== resolvedPath) throw new Error(`Project detector refused ${relativePath}: path changed during inspection`);
    if (metadata.isDirectory()) return "directory";
    if (metadata.isFile()) return "file";
    return null;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT" || (cause as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw cause;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function dependencyNames(packageJson: PackageJson | null): Set<string> {
  const dependencies = objectValue(packageJson?.dependencies);
  const devDependencies = objectValue(packageJson?.devDependencies);
  return new Set([...Object.keys(dependencies ?? {}), ...Object.keys(devDependencies ?? {})]);
}

function detectPackageManager(packageJson: PackageJson | null, markers: string[]): Detection<DetectedPackageManager> {
  const evidence: string[] = [];
  const candidates = new Set<DetectedPackageManager>();
  if (typeof packageJson?.packageManager === "string") {
    const name = packageJson.packageManager.split("@")[0];
    if (name === "pnpm" || name === "npm" || name === "yarn" || name === "bun") {
      candidates.add(name);
      evidence.push(`package.json#packageManager=${packageJson.packageManager}`);
    }
  }
  const lockfiles: Array<[string, DetectedPackageManager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ];
  for (const [file, manager] of lockfiles) {
    if (markers.includes(file)) {
      candidates.add(manager);
      evidence.push(file);
    }
  }
  const values = [...candidates].sort();
  if (values.length === 0) return notDetected(evidence);
  if (values.length === 1) return detected(values[0]!, evidence);
  return ambiguous(values, evidence);
}

function detectFramework(packageJson: PackageJson | null, markers: string[]): Detection<DetectedFramework> {
  const dependencies = dependencyNames(packageJson);
  const found: Array<{ framework: DetectedFramework; evidence: string }> = [];
  if (dependencies.has("next") || markers.some((marker) => /^next\.config\./.test(marker))) {
    found.push({ framework: "nextjs", evidence: dependencies.has("next") ? "package.json dependency: next" : "next.config.*" });
  }
  if (dependencies.has("vite") || markers.some((marker) => /^vite\.config\./.test(marker))) {
    found.push({ framework: "vite", evidence: dependencies.has("vite") ? "package.json dependency: vite" : "vite.config.*" });
  }
  if (dependencies.has("react-scripts")) found.push({ framework: "cra", evidence: "package.json dependency: react-scripts" });
  const unique = [...new Set(found.map(({ framework }) => framework))];
  const evidence = found.map((item) => item.evidence);
  if (unique.length === 0) return notDetected();
  if (unique.length === 1) return detected(unique[0]!, evidence);
  return ambiguous(unique, evidence);
}

function detectScripts(packageJson: PackageJson | null): Detection<Record<string, string>> {
  const scripts = objectValue(packageJson?.scripts);
  if (!scripts) return notDetected();
  const validEntries = Object.entries(scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([left], [right]) => left.localeCompare(right));
  if (validEntries.length === 0) return notDetected(["package.json#scripts"]);
  return detected(Object.fromEntries(validEntries), ["package.json#scripts"]);
}

function detectPort(scripts: Detection<Record<string, string>>): Detection<number> {
  if (scripts.status !== "detected") return notDetected();
  const matches: Array<{ port: number; evidence: string }> = [];
  const patterns = [/(?:^|\s)--port(?:=|\s+)(\d{2,5})(?=\s|$)/g, /(?:^|\s)-p\s+(\d{2,5})(?=\s|$)/g, /(?:^|\s)PORT=(\d{2,5})(?=\s|$)/g];
  for (const [name, command] of Object.entries(scripts.value)) {
    for (const pattern of patterns) {
      for (const match of command.matchAll(pattern)) {
        const port = Number(match[1]);
        if (port >= 1024 && port <= 65_535) matches.push({ port, evidence: `package.json#scripts.${name}` });
      }
    }
  }
  const candidates = [...new Set(matches.map(({ port }) => port))].sort((left, right) => left - right);
  const evidence = [...new Set(matches.map((match) => match.evidence))];
  if (candidates.length === 0) return notDetected();
  if (candidates.length === 1) return detected(candidates[0]!, evidence);
  return ambiguous(candidates, evidence);
}

async function detectTailwind(
  root: string,
  packageJson: PackageJson | null,
  markers: string[],
  signal: AbortSignal,
): Promise<ProjectDetection["tailwind"]> {
  const dependencies = dependencyNames(packageJson);
  const packageName = dependencies.has("tailwindcss") ? "tailwindcss" : dependencies.has("@tailwindcss/vite") ? "@tailwindcss/vite" : null;
  const configPath = markers.find((marker) => /^tailwind\.config\./.test(marker)) ?? null;
  const cssCandidates = ["src/index.css", "src/app.css", "src/styles.css", "app/globals.css", "src/app/globals.css", "styles/globals.css"];
  let cssEvidence: string | null = null;
  for (const candidate of cssCandidates) {
    const file = await readKnownFile(root, candidate, signal);
    if (file && "text" in file && /@(?:import\s+["']tailwindcss["']|tailwind\s|theme\s)/.test(file.text)) {
      cssEvidence = candidate;
      break;
    }
  }
  const evidence = [packageName ? `package.json dependency: ${packageName}` : null, configPath, cssEvidence].filter((value): value is string => value !== null);
  return evidence.length > 0 ? detected({ configPath, packageName }, evidence) : notDetected();
}

async function detectShadcn(root: string, signal: AbortSignal): Promise<ProjectDetection["shadcn"]> {
  const file = await readKnownFile(root, "components.json", signal);
  if (!file) return notDetected();
  if (!("text" in file)) return deferred("components.json exceeds the passive inspection size limit", [file.path]);
  try {
    const value = objectValue(JSON.parse(file.text));
    if (!value) return deferred("components.json is not a JSON object", [file.path]);
    return detected({
      configPath: file.path,
      style: typeof value.style === "string" ? value.style : null,
      iconLibrary: typeof value.iconLibrary === "string" ? value.iconLibrary : null,
    }, [file.path]);
  } catch {
    return deferred("components.json could not be parsed", [file.path]);
  }
}

async function detectEntryRoute(
  root: string,
  framework: Detection<DetectedFramework>,
  monorepoMarkers: string[],
  signal: AbortSignal,
): Promise<ProjectDetection["entryRoute"]> {
  if (monorepoMarkers.length > 0) {
    return deferred("select a workspace package before detecting its entry route", monorepoMarkers);
  }
  const candidates = framework.status === "detected" && framework.value === "nextjs"
    ? ["app/page.tsx", "app/page.jsx", "src/app/page.tsx", "src/app/page.jsx", "pages/index.tsx", "pages/index.jsx", "src/pages/index.tsx", "src/pages/index.jsx"]
    : ["index.html", "src/App.tsx", "src/App.jsx"];
  const evidence: string[] = [];
  for (const candidate of candidates) {
    if (await fileKind(root, candidate, signal) === "file") evidence.push(candidate);
  }
  if (evidence.length > 0) return detected("/", evidence);
  if (framework.status === "ambiguous") return deferred("resolve the framework before detecting an entry route", framework.evidence);
  return notDetected();
}

const KNOWN_ROOT_MARKERS = [
  "package.json", "pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb",
  "pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json", "components.json",
  "next.config.js", "next.config.mjs", "next.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.ts",
  "tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs", "tailwind.config.ts",
] as const;

export async function detectProject(projectPath: string, options: { signal?: AbortSignal } = {}): Promise<ProjectDetection> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const canonicalPath = await realpath(path.resolve(projectPath));
  signal.throwIfAborted();

  const markers: string[] = [];
  for (const marker of KNOWN_ROOT_MARKERS) {
    if (await fileKind(canonicalPath, marker, signal)) markers.push(marker);
  }

  const packageFile = await readKnownFile(canonicalPath, "package.json", signal);
  let packageJson: PackageJson | null = null;
  let packageJsonProblem: string | null = null;
  if (packageFile) {
    if (!("text" in packageFile)) {
      packageJsonProblem = "package.json exceeds the passive inspection size limit";
    } else {
      try {
        packageJson = objectValue(JSON.parse(packageFile.text));
        if (packageJson === null) packageJsonProblem = "package.json is not a JSON object";
      } catch {
        packageJsonProblem = "package.json could not be parsed";
      }
    }
  }

  const workspaceMarkers = [
    ...markers.filter((marker) => ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"].includes(marker)),
    ...(packageJson?.workspaces !== undefined ? ["package.json#workspaces"] : []),
  ];
  const scripts = packageJsonProblem ? deferred<Record<string, string>>(packageJsonProblem, ["package.json"]) : detectScripts(packageJson);
  const framework = packageJsonProblem
    ? deferred<DetectedFramework>(packageJsonProblem, ["package.json"])
    : detectFramework(packageJson, markers);
  const packageManager = packageJsonProblem
    ? deferred<DetectedPackageManager>(packageJsonProblem, ["package.json"])
    : detectPackageManager(packageJson, markers);
  const gitKind = await fileKind(canonicalPath, ".git", signal);

  return {
    canonicalPath,
    packageManager,
    framework,
    scripts,
    preferredPort: detectPort(scripts),
    tailwind: await detectTailwind(canonicalPath, packageJson, markers, signal),
    shadcn: await detectShadcn(canonicalPath, signal),
    git: gitKind ? detected({ metadataPath: ".git", kind: gitKind }, [".git"]) : notDetected(),
    entryRoute: await detectEntryRoute(canonicalPath, framework, workspaceMarkers, signal),
    monorepo: workspaceMarkers.length > 0
      ? deferred("workspace root detected; package selection is intentionally deferred", workspaceMarkers)
      : notDetected(),
  };
}
