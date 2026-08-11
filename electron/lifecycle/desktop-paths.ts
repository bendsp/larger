import { lstat, mkdir, realpath } from "node:fs/promises";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

export interface DesktopPaths {
  readonly userDataRoot: string;
  readonly stateRoot: string;
  readonly runtimeWorkspacesRoot: string;
  readonly recoveryRoot: string;
  readonly processOwnershipRoot: string;
  readonly crashDumpsRoot: string;
  readonly cacheRoot: string;
  readonly sessionDataRoot: string;
  readonly logsRoot: string;
}

export interface ElectronPathAdapter {
  setPath(name: "sessionData" | "crashDumps", value: string): void;
  setAppLogsPath(value?: string): void;
}

async function ensureRealDirectory(parent: string, name: string): Promise<string> {
  const candidate = path.join(parent, name);
  try {
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Managed desktop path must be a real directory: ${candidate}`);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    try {
      await mkdir(candidate, { mode: 0o700 });
    } catch (mkdirCause) {
      if ((mkdirCause as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirCause;
    }
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Managed desktop path must be a real directory: ${candidate}`);
    }
  }

  const canonical = await realpath(candidate);
  if (path.dirname(canonical) !== parent) {
    throw new Error(`Managed desktop path escapes its canonical parent: ${candidate}`);
  }
  return canonical;
}

function ensureRealDirectorySync(parent: string, name: string): string {
  const candidate = path.join(parent, name);
  try {
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Managed desktop path must be a real directory: ${candidate}`);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    try {
      mkdirSync(candidate, { mode: 0o700 });
    } catch (mkdirCause) {
      if ((mkdirCause as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirCause;
    }
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Managed desktop path must be a real directory: ${candidate}`);
    }
  }

  const canonical = realpathSync(candidate);
  if (path.dirname(canonical) !== parent) {
    throw new Error(`Managed desktop path escapes its canonical parent: ${candidate}`);
  }
  return canonical;
}

function desktopPathsFromCanonicalRoot(
  userDataRoot: string,
  ensure: (parent: string, name: string) => string,
): DesktopPaths {
  const stateRoot = ensure(userDataRoot, "state");
  const runtimeWorkspacesRoot = ensure(userDataRoot, "runtime-workspaces");
  const recoveryRoot = ensure(userDataRoot, "recovery");
  const cacheRoot = ensure(userDataRoot, "cache");
  const logsRoot = ensure(userDataRoot, "logs");
  const processOwnershipRoot = ensure(recoveryRoot, "process-ownership");
  const crashDumpsRoot = ensure(recoveryRoot, "crash-dumps");
  const sessionDataRoot = ensure(cacheRoot, "chromium");

  return {
    userDataRoot,
    stateRoot,
    runtimeWorkspacesRoot,
    recoveryRoot,
    processOwnershipRoot,
    crashDumpsRoot,
    cacheRoot,
    sessionDataRoot,
    logsRoot,
  };
}

/** Synchronous by design so Electron paths can be applied before the first startup await. */
export function prepareDesktopPathsSync(userDataPath: string): DesktopPaths {
  const requestedRoot = path.resolve(userDataPath);
  mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
  const userDataRoot = realpathSync(requestedRoot);
  return desktopPathsFromCanonicalRoot(userDataRoot, ensureRealDirectorySync);
}

export async function prepareDesktopPaths(userDataPath: string): Promise<DesktopPaths> {
  const requestedRoot = path.resolve(userDataPath);
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const userDataRoot = await realpath(requestedRoot);

  const [stateRoot, runtimeWorkspacesRoot, recoveryRoot, cacheRoot, logsRoot] = await Promise.all([
    ensureRealDirectory(userDataRoot, "state"),
    ensureRealDirectory(userDataRoot, "runtime-workspaces"),
    ensureRealDirectory(userDataRoot, "recovery"),
    ensureRealDirectory(userDataRoot, "cache"),
    ensureRealDirectory(userDataRoot, "logs"),
  ]);
  const [processOwnershipRoot, crashDumpsRoot, sessionDataRoot] = await Promise.all([
    ensureRealDirectory(recoveryRoot, "process-ownership"),
    ensureRealDirectory(recoveryRoot, "crash-dumps"),
    ensureRealDirectory(cacheRoot, "chromium"),
  ]);
  return {
    userDataRoot,
    stateRoot,
    runtimeWorkspacesRoot,
    recoveryRoot,
    processOwnershipRoot,
    crashDumpsRoot,
    cacheRoot,
    sessionDataRoot,
    logsRoot,
  };
}

/** Must be called before Electron's ready event. */
export function applyPreReadyElectronPaths(adapter: ElectronPathAdapter, paths: DesktopPaths): void {
  adapter.setPath("sessionData", paths.sessionDataRoot);
  adapter.setPath("crashDumps", paths.crashDumpsRoot);
  adapter.setAppLogsPath(paths.logsRoot);
}
