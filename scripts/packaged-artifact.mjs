import { access, readdir } from "node:fs/promises";
import path from "node:path";

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function findPackagedApplication(requestedPath = process.env.LARGER_PACKAGED_ARTIFACT) {
  if (requestedPath) {
    const resolved = path.resolve(requestedPath);
    if (!await exists(resolved)) throw new Error(`Packaged application does not exist: ${resolved}`);
    return resolved;
  }
  const outputRoot = path.resolve(".larger/out");
  const candidates = [];
  for (const child of await readdir(outputRoot, { withFileTypes: true })) {
    if (!child.isDirectory() || child.name === "make") continue;
    const directory = path.join(outputRoot, child.name);
    if (process.platform === "darwin") {
      const application = path.join(directory, "Larger.app");
      if (await exists(application)) candidates.push(application);
    } else {
      const executable = path.join(directory, process.platform === "win32" ? "Larger.exe" : "Larger");
      if (await exists(executable)) candidates.push(directory);
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one packaged Larger application, found ${candidates.length}.`);
  }
  return candidates[0];
}

export function packagedApplicationLayout(applicationPath) {
  if (process.platform === "darwin") {
    return {
      applicationPath,
      resourcesPath: path.join(applicationPath, "Contents", "Resources"),
      executablePath: path.join(applicationPath, "Contents", "MacOS", "Larger"),
    };
  }
  return {
    applicationPath,
    resourcesPath: path.join(applicationPath, "resources"),
    executablePath: path.join(applicationPath, process.platform === "win32" ? "Larger.exe" : "Larger"),
  };
}
