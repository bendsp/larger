import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  captureInventory,
  createBaselineManifest,
  makeBaselineTreeReadOnly,
  validateSourceSnapshot,
  verifyBaselineTree,
} from "./inventory.js";
import { FallbackMaterializer } from "./materializers.js";
import {
  assertManagedPathParents,
  assertSafeMaterializedSymlink,
  createWorkspacePaths,
  isContainedPath,
  manifestEntryPath,
  WorkspaceSecurityError,
} from "./security.js";
import type {
  BaselineManifest,
  CurrentWorkspace,
  MaterializationBackend,
  RuntimeWorkspace,
  StageWorkspaceOptions,
  StagingPhase,
  WorkspacePaths,
} from "./types.js";

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const handle = await open(directoryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
}

async function writeJsonDurably(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await syncFile(filePath);
}

async function publishJsonAtomically(filePath: string, value: unknown, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeJsonDurably(temporaryPath, value);
    signal?.throwIfAborted();
    await rename(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function parseManifest(raw: string, baselineTreePath: string): BaselineManifest {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    !("formatVersion" in value) ||
    value.formatVersion !== 1 ||
    !("identity" in value) ||
    typeof value.identity !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.identity) ||
    !("entries" in value) ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("Baseline manifest is invalid.");
  }
  const paths = new Set<string>();
  for (const entry of value.entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("path" in entry) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      paths.has(entry.path) ||
      !("type" in entry) ||
      !new Set(["directory", "file", "symlink"]).has(String(entry.type)) ||
      !("mode" in entry) ||
      !Number.isInteger(entry.mode) ||
      Number(entry.mode) < 0 ||
      Number(entry.mode) > 0o777
    ) {
      throw new Error("Baseline manifest contains an invalid entry.");
    }
    manifestEntryPath(baselineTreePath, entry.path);
    paths.add(entry.path);
    if (
      entry.type === "file" &&
      (!("size" in entry) ||
        !Number.isSafeInteger(entry.size) ||
        Number(entry.size) < 0 ||
        !("contentSha256" in entry) ||
        typeof entry.contentSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.contentSha256))
    ) {
      throw new Error("Baseline manifest contains an invalid file entry.");
    }
    if (
      entry.type === "symlink" &&
      (!("target" in entry) ||
        typeof entry.target !== "string" ||
        !("materializedTarget" in entry) ||
        typeof entry.materializedTarget !== "string" ||
        !("scope" in entry) ||
        entry.scope !== "internal")
    ) {
      throw new Error("Baseline manifest contains an invalid symlink entry.");
    }
    if (entry.type === "symlink") {
      assertSafeMaterializedSymlink(baselineTreePath, entry.path, entry.materializedTarget as string);
    }
  }
  return value as unknown as BaselineManifest;
}

async function loadManifest(baselinePath: string): Promise<BaselineManifest> {
  const manifestPath = path.join(baselinePath, "manifest.json");
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new WorkspaceSecurityError("Baseline manifest must be a regular file.");
  }
  return parseManifest(await readFile(manifestPath, "utf8"), path.join(baselinePath, "tree"));
}

async function makeTreeWritable(root: string): Promise<void> {
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;
  await chmod(root, 0o700);
  for (const child of await readdir(root, { withFileTypes: true })) {
    const childPath = path.join(root, child.name);
    if (child.isDirectory() && !child.isSymbolicLink()) {
      await makeTreeWritable(childPath);
    } else if (!child.isSymbolicLink()) {
      await chmod(childPath, 0o600);
    }
  }
}

async function removeStagingTree(stagingPath: string): Promise<void> {
  await makeTreeWritable(stagingPath);
  await rm(stagingPath, { recursive: true, force: true });
}

async function syncBaselineTree(treePath: string, manifest: BaselineManifest, signal?: AbortSignal): Promise<void> {
  for (const entry of manifest.entries) {
    signal?.throwIfAborted();
    const entryPath = path.join(treePath, ...entry.path.split("/"));
    if (entry.type === "file") await syncFile(entryPath);
  }
  for (const entry of [...manifest.entries].reverse()) {
    signal?.throwIfAborted();
    if (entry.type === "directory") {
      await syncDirectory(path.join(treePath, ...entry.path.split("/")));
    }
  }
  await syncDirectory(treePath);
}

async function emitPhase(
  phase: StagingPhase,
  options: StageWorkspaceOptions,
): Promise<void> {
  options.signal?.throwIfAborted();
  await options.onPhase?.(phase);
  options.signal?.throwIfAborted();
}

async function installBaseline(
  paths: WorkspacePaths,
  stagedBaselinePath: string,
  manifest: BaselineManifest,
  signal?: AbortSignal,
): Promise<string> {
  const baselinePath = path.join(paths.baselinesRoot, manifest.identity);
  await assertManagedPathParents(paths.instanceRoot, baselinePath);
  let baselineAlreadyExists = false;
  try {
    baselineAlreadyExists = (await lstat(baselinePath)).isDirectory();
    if (!baselineAlreadyExists) throw new Error(`Baseline path is not a directory: ${baselinePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    if (baselineAlreadyExists) {
      await removeStagingTree(stagedBaselinePath);
    } else {
      await rename(stagedBaselinePath, baselinePath);
      await syncDirectory(paths.baselinesRoot);
    }
  } catch (error) {
    try {
      const racedBaseline = await lstat(baselinePath);
      if (!racedBaseline.isDirectory() || racedBaseline.isSymbolicLink()) throw error;
    } catch (inspectionError) {
      if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") throw error;
      throw inspectionError;
    }
    await removeStagingTree(stagedBaselinePath);
  }

  const installedManifest = await loadManifest(baselinePath);
  if (installedManifest.identity !== manifest.identity) {
    throw new Error(`Baseline identity collision at ${manifest.identity}.`);
  }
  await verifyBaselineTree(path.join(baselinePath, "tree"), installedManifest, signal);
  await chmod(baselinePath, 0o500);
  return baselinePath;
}

export interface RuntimeWorkspaceProviderOptions {
  readonly userDataPath: string;
  readonly localInstanceKey: string;
  readonly materializer?: MaterializationBackend;
}

export class RuntimeWorkspaceProvider {
  private readonly materializer: MaterializationBackend;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: RuntimeWorkspaceProviderOptions) {
    this.materializer = options.materializer ?? new FallbackMaterializer();
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  stage(sourceRoot: string, options: StageWorkspaceOptions = {}): Promise<RuntimeWorkspace> {
    return this.serialize(async () => {
      options.signal?.throwIfAborted();
      const canonicalSourceRoot = await realpath(sourceRoot);
      const requestedUserDataPath = path.resolve(this.options.userDataPath);
      if (isContainedPath(canonicalSourceRoot, requestedUserDataPath)) {
        throw new WorkspaceSecurityError("Managed runtime storage must not be created inside a source project.");
      }
      const paths = await createWorkspacePaths(this.options.userDataPath, this.options.localInstanceKey);
      if (
        isContainedPath(canonicalSourceRoot, paths.storageRoot) ||
        isContainedPath(paths.storageRoot, canonicalSourceRoot)
      ) {
        throw new WorkspaceSecurityError("Source projects and managed runtime storage must not overlap.");
      }
      const operationId = randomUUID();
      const stagingPath = path.join(paths.stagingRoot, operationId);
      const stagedBaselinePath = path.join(stagingPath, "baseline");
      const stagedBaselineTreePath = path.join(stagedBaselinePath, "tree");
      const stagedRuntimePath = path.join(stagingPath, "runtime");
      await assertManagedPathParents(paths.instanceRoot, stagingPath);
      await mkdir(stagingPath, { mode: 0o700 });
      await mkdir(stagedBaselinePath, { mode: 0o700 });
      let installedRuntimePath: string | undefined;
      let published = false;

      try {
        await emitPhase("inventory-started", options);
        const snapshot = await captureInventory(
          sourceRoot,
          stagedBaselineTreePath,
          options.signal,
          () => emitPhase("inventory-progress", options),
        );
        const manifest = createBaselineManifest(snapshot.entries);
        await emitPhase("inventory-complete", options);

        await validateSourceSnapshot(snapshot, options.signal);
        await emitPhase("source-validated", options);

        const manifestPath = path.join(stagedBaselinePath, "manifest.json");
        await writeJsonDurably(manifestPath, manifest);
        await syncBaselineTree(stagedBaselineTreePath, manifest, options.signal);
        await makeBaselineTreeReadOnly(stagedBaselineTreePath, manifest.entries, options.signal);
        await chmod(manifestPath, 0o400);
        await emitPhase("baseline-prepared", options);

        const baselinePath = await installBaseline(paths, stagedBaselinePath, manifest, options.signal);
        await emitPhase("baseline-installed", options);

        const installedManifest = await loadManifest(baselinePath);
        await verifyBaselineTree(path.join(baselinePath, "tree"), installedManifest, options.signal);
        await this.materializer.materialize(
          path.join(baselinePath, "tree"),
          stagedRuntimePath,
          installedManifest,
          options.signal,
        );
        await emitPhase("runtime-materialized", options);

        const runtimeId = randomUUID();
        const runtimePath = path.join(paths.runtimesRoot, runtimeId);
        await assertManagedPathParents(paths.instanceRoot, runtimePath);
        await rename(stagedRuntimePath, runtimePath);
        installedRuntimePath = runtimePath;
        await syncDirectory(paths.runtimesRoot);
        await emitPhase("runtime-installed", options);

        const pointer: CurrentWorkspace = {
          formatVersion: 1,
          baselineIdentity: manifest.identity,
          runtimeId,
          publishedAt: new Date().toISOString(),
        };
        await emitPhase("before-publication", options);
        await publishJsonAtomically(paths.currentPointerPath, pointer, options.signal);
        published = true;

        return {
          baselineIdentity: manifest.identity,
          baselinePath,
          runtimeId,
          runtimePath,
          manifest,
        };
      } finally {
        if (!published && installedRuntimePath) {
          await removeStagingTree(installedRuntimePath);
        }
        await removeStagingTree(stagingPath);
      }
    });
  }

  resetCurrent(signal?: AbortSignal): Promise<RuntimeWorkspace> {
    return this.serialize(async () => {
      signal?.throwIfAborted();
      const current = await this.current();
      if (!current) throw new Error("There is no current runtime workspace to reset.");
      const paths = await createWorkspacePaths(this.options.userDataPath, this.options.localInstanceKey);
      const operationId = randomUUID();
      const stagingPath = path.join(paths.stagingRoot, `reset-${operationId}`);
      const stagedRuntimePath = path.join(stagingPath, "runtime");
      let installedRuntimePath: string | undefined;
      let published = false;
      await mkdir(stagingPath, { mode: 0o700 });
      try {
        await verifyBaselineTree(path.join(current.baselinePath, "tree"), current.manifest, signal);
        await this.materializer.materialize(
          path.join(current.baselinePath, "tree"),
          stagedRuntimePath,
          current.manifest,
          signal,
        );
        signal?.throwIfAborted();
        const runtimeId = randomUUID();
        const runtimePath = path.join(paths.runtimesRoot, runtimeId);
        await assertManagedPathParents(paths.instanceRoot, runtimePath);
        await rename(stagedRuntimePath, runtimePath);
        installedRuntimePath = runtimePath;
        await syncDirectory(paths.runtimesRoot);
        signal?.throwIfAborted();
        await publishJsonAtomically(paths.currentPointerPath, {
          formatVersion: 1,
          baselineIdentity: current.baselineIdentity,
          runtimeId,
          publishedAt: new Date().toISOString(),
        } satisfies CurrentWorkspace, signal);
        published = true;
        await removeStagingTree(current.runtimePath).catch(() => undefined);
        await syncDirectory(paths.runtimesRoot).catch(() => undefined);
        return {
          baselineIdentity: current.baselineIdentity,
          baselinePath: current.baselinePath,
          runtimeId,
          runtimePath,
          manifest: current.manifest,
        };
      } finally {
        if (!published && installedRuntimePath) await removeStagingTree(installedRuntimePath);
        await removeStagingTree(stagingPath);
      }
    });
  }

  async current(): Promise<RuntimeWorkspace | undefined> {
    const paths = await createWorkspacePaths(this.options.userDataPath, this.options.localInstanceKey);
    let raw: string;
    try {
      const pointerStat = await lstat(paths.currentPointerPath);
      if (!pointerStat.isFile() || pointerStat.isSymbolicLink()) {
        throw new WorkspaceSecurityError("Current runtime pointer must be a regular file.");
      }
      raw = await readFile(paths.currentPointerPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("formatVersion" in value) ||
      value.formatVersion !== 1 ||
      !("baselineIdentity" in value) ||
      typeof value.baselineIdentity !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.baselineIdentity) ||
      !("runtimeId" in value) ||
      typeof value.runtimeId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.runtimeId)
    ) {
      throw new Error("Current runtime pointer is invalid.");
    }
    const pointer = value as unknown as CurrentWorkspace;
    const baselinePath = path.join(paths.baselinesRoot, pointer.baselineIdentity);
    const runtimePath = path.join(paths.runtimesRoot, pointer.runtimeId);
    await assertManagedPathParents(paths.instanceRoot, baselinePath);
    await assertManagedPathParents(paths.instanceRoot, runtimePath);
    const [baselineStat, runtimeStat] = await Promise.all([lstat(baselinePath), lstat(runtimePath)]);
    if (
      !baselineStat.isDirectory()
      || baselineStat.isSymbolicLink()
      || !runtimeStat.isDirectory()
      || runtimeStat.isSymbolicLink()
    ) {
      throw new Error("Current runtime pointer references missing workspace data.");
    }
    const [canonicalBaseline, canonicalRuntime] = await Promise.all([realpath(baselinePath), realpath(runtimePath)]);
    if (!isContainedPath(paths.instanceRoot, canonicalBaseline) || !isContainedPath(paths.instanceRoot, canonicalRuntime)) {
      throw new WorkspaceSecurityError("Current runtime pointer escapes managed storage.");
    }
    const manifest = await loadManifest(baselinePath);
    if (manifest.identity !== pointer.baselineIdentity) {
      throw new Error("Current runtime pointer does not match its baseline manifest.");
    }
    await verifyBaselineTree(path.join(baselinePath, "tree"), manifest);
    return {
      baselineIdentity: pointer.baselineIdentity,
      baselinePath,
      runtimeId: pointer.runtimeId,
      runtimePath,
      manifest,
    };
  }
}
