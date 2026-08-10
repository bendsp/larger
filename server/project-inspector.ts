import { execFile } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  BrandFont,
  BrandToken,
  Framework,
  PackageManager,
  ProjectAsset,
  ProjectComponent,
  ProjectRoute,
  ProjectSummary,
} from "../src/contracts.js";

const execFileAsync = promisify(execFile);
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const FONT_EXTENSIONS = new Set([".eot", ".otf", ".ttf", ".woff", ".woff2"]);
const SKIPPED_DIRECTORIES = new Set([".git", ".next", "dist", "node_modules", "out"]);

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root: string, relativeDirectory = "", limit = 4_000): Promise<{ files: string[]; truncated: boolean }> {
  const { readdir } = await import("node:fs/promises");
  const results: string[] = [];
  const pending = [relativeDirectory];

  while (pending.length > 0 && results.length <= limit) {
    const current = pending.shift() ?? "";
    const absolute = path.join(root, current);
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const relative = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".next")) {
          pending.push(relative);
        }
      } else if (entry.isFile()) {
        results.push(relative);
        if (results.length > limit) break;
      }
    }
  }

  return {
    files: results.slice(0, limit).sort((a, b) => a.localeCompare(b)),
    truncated: results.length > limit,
  };
}

function detectFramework(files: Set<string>, packageJson: Record<string, unknown>): Framework {
  if (["next.config.js", "next.config.mjs", "next.config.ts"].some((file) => files.has(file))) {
    return "nextjs";
  }
  if (["vite.config.js", "vite.config.mjs", "vite.config.ts"].some((file) => files.has(file))) {
    return "vite";
  }
  const dependencies = {
    ...((packageJson.dependencies as Record<string, string> | undefined) ?? {}),
    ...((packageJson.devDependencies as Record<string, string> | undefined) ?? {}),
  };
  return dependencies["react-scripts"] ? "cra" : "unknown";
}

function detectPackageManager(files: Set<string>): PackageManager {
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("bun.lock") || files.has("bun.lockb")) return "bun";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("package-lock.json")) return "npm";
  return "unknown";
}

function routeFromPageFile(file: string): ProjectRoute | null {
  const normalized = file.split(path.sep).join("/");
  if (!normalized.startsWith("app/") || !/\/page\.(?:js|jsx|ts|tsx|md|mdx)$/.test(normalized)) {
    return null;
  }
  const directory = normalized
    .replace(/^app\//, "")
    .replace(/(?:^|\/)page\.(?:js|jsx|ts|tsx|md|mdx)$/, "");
  const routeParts = directory
    .split("/")
    .filter(Boolean)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")));
  const route = `/${routeParts.join("/")}`.replace(/\/$/, "") || "/";
  return {
    path: route,
    file: normalized,
    kind: route.includes("[") ? "dynamic" : "page",
  };
}

function componentFromFile(file: string): ProjectComponent | null {
  const normalized = file.split(path.sep).join("/");
  const match = normalized.match(/(?:^|\/)components\/(.+)\.(?:jsx|tsx)$/);
  if (!match) return null;
  const stem = match[1];
  const name = path.basename(stem).replace(/(^|-)([a-z])/g, (_, _prefix: string, char: string) => char.toUpperCase());
  return {
    name,
    file: normalized,
    family: stem.startsWith("ui/") ? "ui" : "project",
  };
}

function assetKind(file: string): ProjectAsset["kind"] {
  const extension = path.extname(file).toLowerCase();
  if (FONT_EXTENSIONS.has(extension)) return "font";
  if (extension === ".svg" || /(?:^|\/)(?:icon|icons)(?:\/|-)/i.test(file)) return "icon";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return "other";
}

function parseCssBrand(css: string, source: string): { tokens: BrandToken[]; fonts: BrandFont[] } {
  const tokens: BrandToken[] = [];
  const fonts: BrandFont[] = [];
  const blockPatterns: Array<[string, RegExp]> = [
    ["light", /:root\s*\{([\s\S]*?)\}/g],
    ["dark", /\.dark\s*\{([\s\S]*?)\}/g],
  ];

  for (const [mode, blockPattern] of blockPatterns) {
    for (const blockMatch of css.matchAll(blockPattern)) {
      for (const tokenMatch of blockMatch[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        tokens.push({
          name: tokenMatch[1],
          value: tokenMatch[2].trim(),
          mode,
          source,
        });
      }
    }
  }

  for (const faceMatch of css.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
    const family = faceMatch[1].match(/font-family\s*:\s*["']?([^;"']+)["']?\s*;/)?.[1]?.trim();
    const weightValue = faceMatch[1].match(/font-weight\s*:\s*(\d+)/)?.[1];
    if (family) {
      fonts.push({ family, source, weights: weightValue ? [Number(weightValue)] : [] });
    }
  }

  return { tokens, fonts };
}

async function inspectGit(root: string): Promise<ProjectSummary["git"]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], {
      cwd: root,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    const lines = stdout.trimEnd().split("\n").filter(Boolean);
    const branchLine = (lines.shift() ?? "## unknown").replace(/^##\s*/, "");
    const [branch] = branchLine.split("...");
    return {
      branch: branch.trim(),
      dirtyFiles: lines.map((line) => line.slice(3).trim()),
    };
  } catch {
    return { branch: "not a git repository", dirtyFiles: [] };
  }
}

export async function inspectProject(name: string, root: string, entryRoute = "/"): Promise<ProjectSummary> {
  const inventory = await walkFiles(root);
  const allFiles = inventory.files;
  const files = new Set(allFiles.map((file) => file.split(path.sep).join("/")));
  const packagePath = path.join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;

  const routes = allFiles
    .map(routeFromPageFile)
    .filter((route): route is ProjectRoute => route !== null)
    .sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path)));

  const components = allFiles
    .map(componentFromFile)
    .filter((component): component is ProjectComponent => component !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  const assetFiles = allFiles.filter((file) => {
    const normalized = file.split(path.sep).join("/");
    return normalized.startsWith("public/") || normalized.startsWith("src/assets/");
  });
  const assetsTruncated = assetFiles.length > 160;
  const assets: ProjectAsset[] = [];
  for (const file of assetFiles.slice(0, 160)) {
    const normalized = file.split(path.sep).join("/");
    const fileStat = await stat(path.join(root, file));
    const kind = assetKind(normalized);
    assets.push({
      name: path.basename(file),
      path: normalized,
      kind,
      bytes: fileStat.size,
      previewUrl: kind === "image" || kind === "icon" ? `/api/asset?path=${encodeURIComponent(normalized)}` : null,
    });
  }

  const allCssFiles = allFiles.filter((file) => path.extname(file) === ".css");
  const cssTruncated = allCssFiles.length > 30;
  const cssFiles = allCssFiles.slice(0, 30);
  const tokens: BrandToken[] = [];
  const fonts: BrandFont[] = [];
  for (const cssFile of cssFiles) {
    const css = await readFile(path.join(root, cssFile), "utf8");
    const parsed = parseCssBrand(css, cssFile.split(path.sep).join("/"));
    tokens.push(...parsed.tokens);
    fonts.push(...parsed.fonts);
  }

  const uniqueTokens = Array.from(
    new Map(tokens.map((token) => [`${token.mode}:${token.name}:${token.value}`, token])).values(),
  );
  const uniqueFonts = Array.from(
    fonts.reduce((byFamily, font) => {
      const existing = byFamily.get(font.family);
      if (!existing) {
        byFamily.set(font.family, font);
      } else {
        existing.weights = Array.from(new Set([...existing.weights, ...font.weights])).sort((a, b) => a - b);
      }
      return byFamily;
    }, new Map<string, BrandFont>()).values(),
  );
  const tailwindConfig = ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs"].find((file) => files.has(file)) ?? null;
  let shadcn: ProjectSummary["brand"]["shadcn"] = {
    detected: false,
    style: null,
    iconLibrary: null,
  };
  if (await exists(path.join(root, "components.json"))) {
    try {
      const componentsJson = JSON.parse(await readFile(path.join(root, "components.json"), "utf8")) as {
        style?: string;
        iconLibrary?: string;
      };
      shadcn = {
        detected: true,
        style: componentsJson.style ?? null,
        iconLibrary: componentsJson.iconLibrary ?? null,
      };
    } catch {
      shadcn.detected = true;
    }
  }

  return {
    name,
    entryRoute,
    framework: detectFramework(files, packageJson),
    packageManager: detectPackageManager(files),
    git: await inspectGit(root),
    routes,
    components,
    assets,
    brand: {
      tokens: uniqueTokens,
      fonts: uniqueFonts,
      tailwindConfig,
      shadcn,
    },
    truncated: {
      files: inventory.truncated,
      assets: assetsTruncated,
      css: cssTruncated,
    },
  };
}

export async function resolveProjectAsset(root: string, requestedPath: string): Promise<string> {
  const normalized = requestedPath.replaceAll("\\", "/");
  if (!normalized.startsWith("public/") && !normalized.startsWith("src/assets/")) {
    throw new Error("Only project asset directories can be served");
  }
  const absolute = path.resolve(root, normalized);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error("Asset path escapes the project root");
  }
  const [canonicalRoot, canonicalAsset] = await Promise.all([realpath(root), realpath(absolute)]);
  if (canonicalAsset !== canonicalRoot && !canonicalAsset.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error("Asset symlink escapes the project root");
  }
  return canonicalAsset;
}

export function mimeTypeForAsset(file: string): string {
  const extension = path.extname(file).toLowerCase();
  const types: Record<string, string> = {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return types[extension] ?? "application/octet-stream";
}
