import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export interface ReactRewriteResourceOptions {
  readonly packageJsonPath: string;
  readonly resourcesPath?: string;
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Resolves the patched CLI in development and in Forge's app.asar. Packaged
 * JavaScript intentionally stays in the signed application archive; Electron's
 * RunAsNode child receives the virtual ASAR path and resolves the same pruned
 * production dependency graph as the main process.
 */
export function resolveReactRewriteCliPath(options: ReactRewriteResourceOptions): string {
  const packageJsonPath = path.resolve(options.packageJsonPath);
  if (path.basename(packageJsonPath) !== "package.json" || path.basename(path.dirname(packageJsonPath)) !== "react-rewrite-cli") {
    throw new Error("React Rewrite package metadata resolved to an unexpected location.");
  }
  const cliPath = path.join(path.dirname(packageJsonPath), "bin", "react-rewrite.js");
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  if (packageJsonPath.includes(asarSegment)) {
    if (!options.resourcesPath) throw new Error("Packaged React Rewrite resolution requires Electron's resources path.");
    const applicationArchive = path.join(path.resolve(options.resourcesPath), "app.asar");
    if (!isContainedPath(applicationArchive, packageJsonPath) || !isContainedPath(applicationArchive, cliPath)) {
      throw new Error("Packaged React Rewrite resource escapes the application archive.");
    }
    return cliPath;
  }

  const packageRoot = realpathSync.native(path.dirname(packageJsonPath));
  const canonicalCli = realpathSync.native(cliPath);
  if (!isContainedPath(packageRoot, canonicalCli)) {
    throw new Error("React Rewrite CLI escapes its package root.");
  }
  const metadata = lstatSync(canonicalCli);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("React Rewrite CLI must be a regular package file.");
  }
  return canonicalCli;
}
