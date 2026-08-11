import type { ForgeConfig } from "@electron-forge/shared-types";
import { execFile } from "node:child_process";
import { cp, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PACKAGE_ROOTS = [
  ".larger/electron",
  "dist",
  "node_modules",
  "package.json",
  "LICENSE",
];

function retainedPackagePath(candidate: string): boolean {
  const normalized = candidate.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalized === "") return true;
  if (normalized.endsWith(".map")) return false;
  return PACKAGE_ROOTS.some((root) => (
    normalized === root || normalized.startsWith(`${root}/`) || root.startsWith(`${normalized}/`)
  ));
}

async function installProductionDependencies(buildPath: string): Promise<void> {
  const sourceRoot = process.cwd();
  const temporaryInputs = [".npmrc", "pnpm-lock.yaml", "patches"] as const;
  await copyFile(path.join(sourceRoot, ".npmrc"), path.join(buildPath, ".npmrc"));
  await copyFile(path.join(sourceRoot, "pnpm-lock.yaml"), path.join(buildPath, "pnpm-lock.yaml"));
  await cp(path.join(sourceRoot, "patches"), path.join(buildPath, "patches"), { recursive: true });
  try {
    await execFileAsync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
      "install",
      "--prod",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
    ], { cwd: buildPath, maxBuffer: 1024 * 1024 });
  } finally {
    await Promise.all(temporaryInputs.map((name) => rm(path.join(buildPath, name), { recursive: true, force: true })));
  }
}

const config: ForgeConfig = {
  outDir: ".larger/out",
  packagerConfig: {
    name: "Larger",
    executableName: "Larger",
    appBundleId: "design.larger.desktop",
    asar: true,
    prune: true,
    ignore: (candidate) => !retainedPackagePath(candidate),
    afterPrune: [((buildPath, _electronVersion, _platform, _arch, done) => {
      void installProductionDependencies(buildPath).then(() => done(), done);
    })],
  },
  makers: [],
  publishers: [],
};

export default config;
