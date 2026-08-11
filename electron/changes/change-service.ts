import { createHash, randomUUID } from "node:crypto";

import type {
  ByteContentIdentity,
  ChangeApplicationSummary,
  ChangeRecoveryMetadata,
  ChangeSelection,
  ChangeSetSnapshot,
  FileApplicationOutcome,
  RecoveryAction,
  TextFileChange,
} from "../../src/change-contracts.js";
import { CHANGE_SET_FORMAT_VERSION } from "../../src/change-contracts.js";
import type {
  ChangeOperationResult,
  ChangeProblem,
  ChangeWorkspaceSnapshot,
  PreparedApplyResult,
} from "../../src/change-ipc.js";
import type { ActiveProject } from "../../src/project-ipc.js";
import type { ProjectIdentity } from "../../src/project-contracts.js";
import type { ProjectActivityCoordinator, ProjectActivityLease } from "../projects/project-activity.js";
import type { ProjectManager } from "../projects/project-manager.js";
import type { RuntimeWorkspaceAccess, RuntimeWorkspaceRegistry } from "../runtime-workspaces/registry.js";
import { createWorkspacePaths } from "../runtime-workspaces/security.js";
import type { RuntimeWorkspace, WorkspacePaths } from "../runtime-workspaces/types.js";
import { BlobStore } from "./blob-store.js";
import { ChangeSetRepository, preserveStableSelection } from "./change-set-repository.js";
import { diffTextFiles } from "./diff-engine.js";
import { assessTransactionRecovery, type RecoveryAssessment } from "./recovery.js";
import { RuntimeChangeScanner } from "./runtime-change-scanner.js";
import {
  authorizeSourceRoot,
  readSourceLeaf,
  sameSourceState,
  sourcePath,
  type AuthorizedSourceRoot,
  type SourceLeafState,
} from "./source-authorization.js";
import {
  findMissingSourceDirectories,
  removeCreatedDirectories,
  removePreparedTemporaryFile,
  SourceCompareAndSwapError,
  writeSourceFileSecurely,
  type SourceWriteOperation,
} from "./secure-source-writer.js";
import { buildSelectedText } from "./selection.js";
import { decodeTextFile, DEFAULT_TEXT_DECODE_LIMITS, type DecodedTextFile } from "./text-codec.js";
import { mergeTextFiles } from "./three-way-merge.js";
import {
  SOURCE_TRANSACTION_FORMAT_VERSION,
  SourceTransactionRepository,
  transactionBlobReference,
  transactionPlanDigest,
  type SourceTransactionFile,
  type SourceTransactionJournal,
  type TransactionFileState,
} from "./transaction-journal.js";

const EMPTY_BYTES = new Uint8Array();
const NO_PROBLEM: ChangeProblem | null = null;

export interface ChangeProjectGateway {
  activeForChanges(generation: number): ActiveProject;
  authorizeSourceOperation(generation: number, expectedInstanceKey: string): Promise<ActiveProject>;
}

export interface ChangeWorkspaceGateway {
  current(identity: ProjectIdentity): Promise<RuntimeWorkspace | undefined>;
  for(identity: ProjectIdentity): Pick<RuntimeWorkspaceAccess, "current" | "resetCurrent">;
}

export interface ChangeActivityGateway {
  acquireSourceWrite(transactionId: string): ProjectActivityLease;
}

export interface ChangeOperationOptions {
  readonly signal?: AbortSignal;
}

export type ChangeTransactionPhase =
  | "journal-prepared"
  | "commit-started"
  | "directories-recorded"
  | "file-intent-recorded"
  | "file-source-durable"
  | "file-state-recorded"
  | "commit-completed"
  | "recovery-started"
  | "recovery-completed";

export interface ChangeServiceDependencies {
  readonly userDataPath: string;
  readonly projects: ChangeProjectGateway | ProjectManager;
  readonly workspaces: ChangeWorkspaceGateway | RuntimeWorkspaceRegistry;
  readonly activity: ChangeActivityGateway | ProjectActivityCoordinator;
  readonly now?: () => Date;
  /** Test and telemetry seam called only after the named durable boundary. */
  readonly onTransactionPhase?: (
    phase: ChangeTransactionPhase,
    journal: SourceTransactionJournal,
  ) => void | Promise<void>;
}

interface ProjectResources {
  readonly paths: WorkspacePaths;
  readonly blobs: BlobStore;
  readonly changeSets: ChangeSetRepository;
  readonly scanner: RuntimeChangeScanner;
  readonly transactions: SourceTransactionRepository;
}

interface PreparedFile {
  readonly file: TextFileChange;
  readonly expected: SourceLeafState;
  readonly result: SourceLeafState;
  readonly operation: "replace" | "delete";
  readonly backup: Uint8Array | null;
  readonly replacement: Uint8Array | null;
  readonly mode: number | null;
  readonly alreadySatisfied: boolean;
  readonly createdDirectories: readonly string[];
}

interface SourceCapture {
  readonly state: SourceLeafState;
  readonly bytes: Uint8Array | null;
}

type SnapshotListener = (snapshot: ChangeWorkspaceSnapshot) => void;

function completed(snapshot: ChangeWorkspaceSnapshot): ChangeOperationResult {
  return { status: "completed", snapshot };
}

function emptyDecoded(): DecodedTextFile {
  const decoded = decodeTextFile(EMPTY_BYTES);
  if (!decoded.ok) throw new Error("The empty UTF-8 sentinel is invalid.");
  return decoded.value;
}

function resultState(bytes: Uint8Array | null, mode: number | null): SourceLeafState {
  if (!bytes) return { kind: "absent", sha256: null, size: 0, mode: null, device: null, inode: null };
  const decoded = decodeTextFile(bytes);
  if (!decoded.ok) throw new Error(`Prepared source result is not supported text: ${decoded.reason}`);
  return {
    kind: "file",
    sha256: decoded.value.metadata.sha256,
    size: bytes.byteLength,
    mode: mode ?? 0o644,
    device: null,
    inode: null,
  };
}

function cloneSelection(selection: ChangeSelection): ChangeSelection {
  return {
    files: selection.files.map((file) => ({
      fileId: file.fileId,
      includeFile: file.includeFile,
      hunkIds: [...file.hunkIds],
    })),
  };
}

function transactionTemporaryName(transactionId: string, relativePath: string): string {
  const pathDigest = createHash("sha256").update(relativePath).digest("hex").slice(0, 16);
  return `.larger-${transactionId}-${pathDigest}.tmp`;
}

function journalRecovery(journal: SourceTransactionJournal, conflictPaths: readonly string[] = []): ChangeRecoveryMetadata {
  const appliedCount = journal.files.filter((file) =>
    file.state === "applied" || file.state === "already-satisfied",
  ).length;
  const pendingCount = journal.files.length - appliedCount;
  return {
    transactionId: journal.transactionId,
    actionRequired: journal.state !== "committed" && journal.state !== "rolled-back",
    availableActions: conflictPaths.length === 0 && journal.state !== "committed" && journal.state !== "rolled-back"
      ? ["roll-forward", "roll-back"]
      : [],
    appliedCount,
    pendingCount,
    conflictPaths: [...conflictPaths],
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function applicationOutcomeFor(state: TransactionFileState): FileApplicationOutcome {
  switch (state) {
    case "applied": return "applied";
    case "already-satisfied": return "already-satisfied";
    case "conflicted": return "conflicted";
    case "rolled-back": return "rolled-back";
    case "rollback-conflict": return "rollback-conflict";
    default: return "pending";
  }
}

function applicationFromJournal(
  snapshot: ChangeSetSnapshot,
  journal: SourceTransactionJournal,
): ChangeApplicationSummary {
  const journalByPath = new Map(journal.files.map((file) => [file.path, file]));
  return {
    transactionId: journal.transactionId,
    planDigest: journal.planDigest,
    files: snapshot.files.map((file) => {
      const entry = journalByPath.get(file.path);
      return {
        path: file.path,
        outcome: file.kind === "unsupported"
          ? "unsupported"
          : entry
            ? applicationOutcomeFor(entry.state)
            : "not-selected",
        sourceBeforeSha256: entry?.expected.sha256 ?? null,
        sourceAfterSha256: entry?.result.sha256 ?? null,
      };
    }),
  };
}

function replaceJournalFile(
  journal: SourceTransactionJournal,
  pathValue: string,
  mutator: (file: SourceTransactionFile) => SourceTransactionFile,
  now: string,
): SourceTransactionJournal {
  let found = false;
  const files = journal.files.map((file) => {
    if (file.path !== pathValue) return file;
    found = true;
    return mutator(file);
  });
  if (!found) throw new Error(`Transaction does not contain ${pathValue}.`);
  return { ...journal, files, updatedAt: now };
}

function reconciledFileState(
  file: SourceTransactionFile,
  assessment: RecoveryAssessment["files"][number],
  action: RecoveryAction,
): Pick<SourceTransactionFile, "state" | "message"> {
  if (assessment.state === "unknown") {
    return {
      state: action === "roll-back" ? "rollback-conflict" : "conflicted",
      message: "Source no longer matches the prepared input or result.",
    };
  }
  if (assessment.state === "expected") {
    return {
      state: action === "roll-back" ? "rolled-back" : "pending",
    };
  }
  if (file.state === "already-satisfied") {
    return { state: "already-satisfied" };
  }
  return {
    state: file.state === "replacement-intent" || file.state === "applied"
      ? "applied"
      : "already-satisfied",
  };
}

function validateStoredDiff(file: TextFileChange, computed: ReturnType<typeof diffTextFiles>): void {
  if (!computed.ok) throw new Error(`Stored diff can no longer be reconstructed: ${file.path}`);
  const storedIds = file.hunks.map((hunk) => hunk.id);
  const computedIds = computed.value.hunks.map((hunk) => hunk.id);
  if (JSON.stringify(storedIds) !== JSON.stringify(computedIds)) {
    throw new Error(`Stored diff integrity check failed: ${file.path}`);
  }
}

export class ChangeService {
  private readonly userDataPath: string;
  private readonly projects: ChangeProjectGateway;
  private readonly workspaces: ChangeWorkspaceGateway;
  private readonly activity: ChangeActivityGateway;
  private readonly now: () => Date;
  private readonly onTransactionPhase?: ChangeServiceDependencies["onTransactionPhase"];
  private readonly listeners = new Set<SnapshotListener>();
  private readonly resources = new Map<string, Promise<ProjectResources>>();
  private readonly resetWorkspaces = new Map<string, RuntimeWorkspace>();
  private operationTail: Promise<void> = Promise.resolve();
  private acceptingOperations = true;
  private workspaceRevision = 0;
  private state: ChangeWorkspaceSnapshot = {
    revision: 0,
    projectGeneration: null,
    projectInstanceKey: null,
    operation: null,
    changeSet: null,
    problem: null,
  };

  constructor(dependencies: ChangeServiceDependencies) {
    this.userDataPath = dependencies.userDataPath;
    this.projects = dependencies.projects;
    this.workspaces = dependencies.workspaces;
    this.activity = dependencies.activity;
    this.now = dependencies.now ?? (() => new Date());
    this.onTransactionPhase = dependencies.onTransactionPhase;
  }

  subscribe(listener: SnapshotListener): () => void {
    if (!this.acceptingOperations) throw new Error("Change service is shutting down");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (!this.acceptingOperations) {
      await this.operationTail;
      return;
    }
    this.acceptingOperations = false;
    await this.operationTail;
    this.listeners.clear();
    this.resources.clear();
    this.resetWorkspaces.clear();
  }

  snapshot(generation: number): Promise<ChangeWorkspaceSnapshot> {
    return this.serialize(async () => {
      const active = this.projects.activeForChanges(generation);
      await this.hydrateProjectState(active);
      return structuredClone(this.state);
    });
  }

  scan(generation: number, options: ChangeOperationOptions = {}): Promise<ChangeOperationResult> {
    return this.serialize(async () => {
      options.signal?.throwIfAborted();
      const active = this.projects.activeForChanges(generation);
      await this.hydrateProjectState(active);
      if (this.state.changeSet?.recovery?.actionRequired || this.state.changeSet?.status === "applying") {
        throw new Error("Recover the active source transaction before scanning the runtime again.");
      }
      this.update({ operation: { kind: "scanning" }, problem: NO_PROBLEM });
      try {
        const workspace = await this.requireWorkspace(active);
        const projectResources = await this.resourcesFor(active.identity.instanceKey);
        const result = await projectResources.scanner.scan(workspace, options.signal);
        options.signal?.throwIfAborted();
        const current = this.state.changeSet;
        const timestamp = this.now().toISOString();
        let next: ChangeSetSnapshot;
        if (
          current
          && current.instanceKey === active.identity.instanceKey
          && current.baselineIdentity === result.baselineIdentity
          && current.origin.runtimeId === result.runtimeId
          && ["detected", "reviewing", "conflicted", "failed"].includes(current.status)
        ) {
          next = await projectResources.changeSets.update({
            ...current,
            revision: current.revision + 1,
            status: "reviewing",
            updatedAt: timestamp,
            files: result.files,
            selection: preserveStableSelection(current.selection, result.files),
            application: null,
            recovery: null,
          }, current.revision);
        } else {
          next = await projectResources.changeSets.create({
            formatVersion: CHANGE_SET_FORMAT_VERSION,
            id: randomUUID(),
            revision: 1,
            projectId: active.identity.projectId,
            instanceKey: active.identity.instanceKey,
            baselineIdentity: result.baselineIdentity,
            origin: { kind: "runtime-workspace", runtimeId: result.runtimeId },
            status: "reviewing",
            createdAt: timestamp,
            updatedAt: timestamp,
            files: result.files,
            selection: { files: [] },
            application: null,
            recovery: null,
          });
        }
        this.update({ operation: null, changeSet: next, problem: NO_PROBLEM });
        return completed(structuredClone(this.state));
      } catch (cause) {
        this.failOperation(cause, "internal");
        throw cause;
      }
    }, options);
  }

  updateSelection(
    generation: number,
    changeSetId: string,
    expectedRevision: number,
    selection: ChangeSelection,
    options: ChangeOperationOptions = {},
  ): Promise<ChangeOperationResult> {
    return this.serialize(async () => {
      options.signal?.throwIfAborted();
      const active = this.projects.activeForChanges(generation);
      this.ensureProjectState(active);
      const resources = await this.resourcesFor(active.identity.instanceKey);
      const current = await this.requireChangeSet(resources, active, changeSetId, expectedRevision);
      if (current.recovery?.actionRequired) throw new Error("Recover the active source transaction before changing selection.");
      if (["applying", "applied", "discarded"].includes(current.status)) {
        throw new Error(`Selection cannot change while a ChangeSet is ${current.status}.`);
      }
      options.signal?.throwIfAborted();
      const next = await resources.changeSets.update({
        ...current,
        revision: current.revision + 1,
        status: "reviewing",
        updatedAt: this.now().toISOString(),
        selection: cloneSelection(selection),
        application: null,
        recovery: null,
      }, current.revision);
      this.update({ changeSet: next, operation: null, problem: NO_PROBLEM });
      return completed(structuredClone(this.state));
    }, options);
  }

  prepareApply(
    generation: number,
    changeSetId: string,
    expectedRevision: number,
    options: ChangeOperationOptions = {},
  ): Promise<PreparedApplyResult> {
    return this.serialize(async () => {
      options.signal?.throwIfAborted();
      const active = this.projects.activeForChanges(generation);
      this.ensureProjectState(active);
      const resources = await this.resourcesFor(active.identity.instanceKey);

      // Lost IPC replies are safe to retry with the pre-prepare revision.
      const visible = await resources.changeSets.load(changeSetId);
      if (
        visible.revision === expectedRevision + 1
        && visible.status === "applying"
        && visible.application
      ) {
        this.assertChangeSetProject(visible, active);
        const journal = await resources.transactions.read(visible.application.transactionId);
        if (journal.planDigest !== visible.application.planDigest || journal.changeSetRevision !== visible.revision) {
          throw new Error("Prepared source transaction no longer matches the ChangeSet.");
        }
        this.update({ changeSet: visible, operation: null, problem: NO_PROBLEM });
        return this.preparedResult(visible, journal);
      }

      const current = await this.requireChangeSet(resources, active, changeSetId, expectedRevision);
      if (current.recovery?.actionRequired) throw new Error("Recover the interrupted source transaction before applying again.");
      if (!["reviewing", "conflicted"].includes(current.status)) {
        throw new Error(`ChangeSet cannot be prepared while ${current.status}.`);
      }
      this.update({ operation: { kind: "preparing-apply" }, problem: NO_PROBLEM });
      try {
        const authorizedProject = await this.projects.authorizeSourceOperation(generation, current.instanceKey);
        options.signal?.throwIfAborted();
        this.assertChangeSetProject(current, authorizedProject);
        const root = await authorizeSourceRoot(authorizedProject.identity.canonicalPath);
        const selected = current.selection.files.filter((selection) => selection.includeFile);
        const selectedFileCount = selected.length;
        const selectedHunkCount = selected.reduce((count, file) => count + file.hunkIds.length, 0);
        if (selectedFileCount === 0) throw new Error("Select at least one supported file before applying.");

        const prepared: PreparedFile[] = [];
        const conflicts: string[] = [];
        for (const selection of selected) {
          options.signal?.throwIfAborted();
          const file = current.files.find((candidate) => candidate.id === selection.fileId);
          if (!file) throw new Error(`Selection references a stale file: ${selection.fileId}`);
          if (file.kind !== "text") throw new Error(`Unsupported file cannot be applied: ${file.path}`);
          const outcome = await this.prepareFile(resources.blobs, root, file, selection.hunkIds);
          if (!outcome) conflicts.push(file.path);
          else prepared.push(outcome);
        }

        if (conflicts.length > 0) {
          const conflicted = await resources.changeSets.update({
            ...current,
            revision: current.revision + 1,
            status: "conflicted",
            updatedAt: this.now().toISOString(),
            application: null,
            recovery: null,
          }, current.revision);
          this.update({
            operation: null,
            changeSet: conflicted,
            problem: {
              code: "source-conflict",
              message: "Source changes overlap the selected runtime changes.",
              recoverable: true,
              paths: conflicts,
            },
          });
          return {
            status: "conflicted",
            transactionId: null,
            planDigest: null,
            selectedFileCount,
            selectedHunkCount,
            conflictPaths: conflicts,
            snapshot: structuredClone(this.state),
          };
        }

        const transactionId = resources.transactions.newTransactionId();
        const plannedRevision = current.revision + 1;
        const plan = prepared.map((entry) => ({
          path: entry.file.path,
          operation: entry.operation,
          expected: entry.expected,
          result: entry.result,
          mode: entry.mode,
          temporaryName: transactionTemporaryName(transactionId, entry.file.path),
        }));
        const planDigest = transactionPlanDigest({
          changeSetId: current.id,
          changeSetRevision: plannedRevision,
          projectId: current.projectId,
          instanceKey: current.instanceKey,
          baselineIdentity: current.baselineIdentity,
          runtimeId: current.origin.runtimeId,
          files: plan,
        });
        const blobBytes = new Map<string, Uint8Array>();
        const journalFiles: SourceTransactionFile[] = prepared.map((entry) => {
          const backup = entry.backup ? transactionBlobReference(entry.backup) : null;
          const replacement = entry.replacement ? transactionBlobReference(entry.replacement) : null;
          if (backup && entry.backup) blobBytes.set(backup.sha256, entry.backup);
          if (replacement && entry.replacement) blobBytes.set(replacement.sha256, entry.replacement);
          return {
            path: entry.file.path,
            operation: entry.operation,
            expected: entry.expected,
            result: entry.result,
            backup,
            replacement,
            mode: entry.mode,
            temporaryName: transactionTemporaryName(transactionId, entry.file.path),
            state: entry.alreadySatisfied ? "already-satisfied" : "pending",
            plannedDirectories: entry.createdDirectories,
            createdDirectories: [],
          };
        });
        const timestamp = this.now().toISOString();
        const journal: SourceTransactionJournal = {
          formatVersion: SOURCE_TRANSACTION_FORMAT_VERSION,
          transactionId,
          changeSetId: current.id,
          changeSetRevision: plannedRevision,
          projectId: current.projectId,
          instanceKey: current.instanceKey,
          projectGeneration: generation,
          canonicalSourceRoot: root.canonicalRoot,
          sourceRootDevice: root.device,
          sourceRootInode: root.inode,
          baselineIdentity: current.baselineIdentity,
          runtimeId: current.origin.runtimeId,
          planDigest,
          createdAt: timestamp,
          updatedAt: timestamp,
          state: "prepared",
          files: journalFiles,
        };
        options.signal?.throwIfAborted();
        await resources.transactions.createJournal(journal, blobBytes);
        await this.phase("journal-prepared", journal);
        options.signal?.throwIfAborted();

        const applying = await resources.changeSets.update({
          ...current,
          revision: plannedRevision,
          status: "applying",
          updatedAt: this.now().toISOString(),
          application: applicationFromJournal(current, journal),
          recovery: journalRecovery(journal),
        }, current.revision);
        this.update({ changeSet: applying, operation: null, problem: NO_PROBLEM });
        return this.preparedResult(applying, journal);
      } catch (cause) {
        this.failOperation(cause, cause instanceof SourceCompareAndSwapError ? "source-conflict" : "internal");
        throw cause;
      }
    }, options);
  }

  commitApply(
    generation: number,
    transactionId: string,
    planDigest: string,
    options: ChangeOperationOptions = {},
  ): Promise<ChangeOperationResult> {
    return this.serialize(async () => {
      options.signal?.throwIfAborted();
      const active = this.projects.activeForChanges(generation);
      this.ensureProjectState(active);
      const resources = await this.resourcesFor(active.identity.instanceKey);
      let journal = await resources.transactions.read(transactionId);
      this.assertJournalProject(journal, active, planDigest, false);
      const changeSet = await resources.changeSets.load(journal.changeSetId);
      this.assertJournalChangeSet(journal, changeSet);
      if (journal.state === "committed") {
        const reconciled = changeSet.status === "applied" && !changeSet.recovery?.actionRequired
          ? changeSet
          : await this.persistJournalState(resources, changeSet, journal, "applied", []);
        this.update({ changeSet: reconciled, operation: null, problem: NO_PROBLEM });
        return completed(structuredClone(this.state));
      }
      if (journal.state === "rolled-back") throw new Error("A rolled-back transaction cannot be committed.");
      const lease = this.activity.acquireSourceWrite(transactionId);
      let root: AuthorizedSourceRoot | null = null;
      try {
        const authorizedProject = await this.projects.authorizeSourceOperation(generation, journal.instanceKey);
        options.signal?.throwIfAborted();
        this.assertChangeSetProject(changeSet, authorizedProject);
        root = await this.authorizeJournalRoot(journal, authorizedProject);
        options.signal?.throwIfAborted();
        // Once the committing journal state is durable, source application owns
        // completion even if the renderer document disappears. Stopping at that
        // point would intentionally create a recovery transaction.
        this.update({ operation: { kind: "applying", transactionId }, problem: NO_PROBLEM });
        journal = await resources.transactions.update(transactionId, (current) => ({
          ...current,
          state: "committing",
          updatedAt: this.now().toISOString(),
        }));
        await this.phase("commit-started", journal);
        journal = await this.applyForward(resources, journal, root, generation);
        journal = await resources.transactions.update(transactionId, (current) => ({
          ...current,
          state: "committed",
          updatedAt: this.now().toISOString(),
        }));
        await this.phase("commit-completed", journal);
        const latest = await resources.changeSets.load(journal.changeSetId);
        const applied = await this.persistJournalState(resources, latest, journal, "applied", []);
        this.update({ changeSet: applied, operation: null, problem: NO_PROBLEM });
        return completed(structuredClone(this.state));
      } catch (cause) {
        if (!root) {
          this.failOperation(cause, "stale-generation");
          throw cause;
        }
        const latestJournal = await resources.transactions.read(transactionId);
        const reconciled = await this.reconcileJournalWithSource(resources, latestJournal, root, "roll-forward");
        const conflictPaths = reconciled.conflictPaths;
        const terminal = conflictPaths.length > 0 || cause instanceof SourceCompareAndSwapError;
        journal = terminal
          ? await resources.transactions.update(transactionId, (current) => ({
            ...current,
            state: "conflicted",
            updatedAt: this.now().toISOString(),
          }))
          : reconciled.journal;
        const latest = await resources.changeSets.load(journal.changeSetId);
        const status = terminal ? "conflicted" : "applying";
        const interrupted = await this.persistJournalState(resources, latest, journal, status, conflictPaths);
        this.update({
          changeSet: interrupted,
          operation: null,
          problem: {
            code: conflictPaths.length > 0 ? "source-conflict" : "recovery-required",
            message: conflictPaths.length > 0
              ? "Source changed during apply and requires manual resolution."
              : `Source application was interrupted: ${errorMessage(cause)}`,
            recoverable: true,
            ...(conflictPaths.length > 0 ? { paths: conflictPaths } : {}),
          },
        });
        return completed(structuredClone(this.state));
      } finally {
        lease.release();
      }
    }, options);
  }

  discard(
    generation: number,
    changeSetId: string,
    expectedRevision: number,
    confirmUnappliedLoss: true,
    options: ChangeOperationOptions = {},
  ): Promise<ChangeOperationResult> {
    return this.serialize(async () => {
      options.signal?.throwIfAborted();
      if (confirmUnappliedLoss !== true) throw new Error("Discard requires explicit confirmation.");
      const active = this.projects.activeForChanges(generation);
      this.ensureProjectState(active);
      const resources = await this.resourcesFor(active.identity.instanceKey);
      const current = await this.requireChangeSet(resources, active, changeSetId, expectedRevision);
      if (current.status === "applying" || current.recovery?.actionRequired) {
        throw new Error("Recover the source transaction before discarding runtime changes.");
      }
      this.update({ operation: { kind: "discarding" }, problem: NO_PROBLEM });
      try {
        const workspace = await this.workspaces.for(active.identity).current();
        if (!workspace || workspace.runtimeId !== current.origin.runtimeId || workspace.baselineIdentity !== current.baselineIdentity) {
          throw new Error("The runtime workspace changed before discard.");
        }
        const reset = await this.workspaces.for(active.identity).resetCurrent(options.signal);
        options.signal?.throwIfAborted();
        if (reset.baselineIdentity !== current.baselineIdentity) {
          throw new Error("Runtime reset produced a different baseline.");
        }
        this.resetWorkspaces.set(active.identity.instanceKey, reset);
        const discarded = await resources.changeSets.update({
          ...current,
          revision: current.revision + 1,
          status: "discarded",
          updatedAt: this.now().toISOString(),
          application: null,
          recovery: null,
        }, current.revision);
        this.update({ changeSet: discarded, operation: null, problem: NO_PROBLEM });
        return completed(structuredClone(this.state));
      } catch (cause) {
        this.failOperation(cause, "internal");
        throw cause;
      }
    }, options);
  }

  recover(
    generation: number,
    transactionId: string,
    action: RecoveryAction,
    options: ChangeOperationOptions = {},
  ): Promise<ChangeOperationResult> {
    return this.serialize(async () => {
      options.signal?.throwIfAborted();
      const active = this.projects.activeForChanges(generation);
      this.ensureProjectState(active);
      const resources = await this.resourcesFor(active.identity.instanceKey);
      let journal = await resources.transactions.read(transactionId);
      this.assertJournalProject(journal, active, journal.planDigest, true);
      const changeSet = await resources.changeSets.load(journal.changeSetId);
      this.assertJournalChangeSet(journal, changeSet);
      if (action === "roll-forward" && journal.state === "committed") {
        const reconciled = changeSet.status === "applied" && !changeSet.recovery?.actionRequired
          ? changeSet
          : await this.persistJournalState(resources, changeSet, journal, "applied", []);
        this.update({ changeSet: reconciled, operation: null, problem: NO_PROBLEM });
        return completed(structuredClone(this.state));
      }
      if (action === "roll-back" && journal.state === "rolled-back") {
        const reconciled = changeSet.status === "reviewing" && !changeSet.recovery?.actionRequired
          ? changeSet
          : await this.persistJournalState(resources, changeSet, journal, "reviewing", []);
        this.update({ changeSet: reconciled, operation: null, problem: NO_PROBLEM });
        return completed(structuredClone(this.state));
      }
      const lease = this.activity.acquireSourceWrite(transactionId);
      let root: AuthorizedSourceRoot | null = null;
      try {
        const authorizedProject = await this.projects.authorizeSourceOperation(generation, journal.instanceKey);
        options.signal?.throwIfAborted();
        this.assertChangeSetProject(changeSet, authorizedProject);
        root = await this.authorizeJournalRoot(journal, authorizedProject);
        options.signal?.throwIfAborted();
        const reconciled = await this.reconcileJournalWithSource(resources, journal, root, action);
        journal = reconciled.journal;
        const unknownPaths = reconciled.conflictPaths;
        if (unknownPaths.length > 0) {
          journal = await resources.transactions.update(transactionId, (current) => ({
            ...current,
            state: "conflicted",
            updatedAt: this.now().toISOString(),
          }));
          const latest = await resources.changeSets.load(journal.changeSetId);
          const conflicted = await this.persistJournalState(resources, latest, journal, "conflicted", unknownPaths);
          this.update({
            changeSet: conflicted,
            operation: null,
            problem: {
              code: "source-conflict",
              message: "Source no longer matches either side of the recoverable transaction.",
              recoverable: true,
              paths: unknownPaths,
            },
          });
          return completed(structuredClone(this.state));
        }

        this.update({ operation: { kind: "recovering", transactionId }, problem: NO_PROBLEM });
        journal = await resources.transactions.update(transactionId, (current) => ({
          ...current,
          state: action === "roll-forward" ? "committing" : "rolling-back",
          updatedAt: this.now().toISOString(),
        }));
        await this.phase("recovery-started", journal);
        journal = action === "roll-forward"
          ? await this.applyForward(resources, journal, root, generation)
          : await this.applyRollback(resources, journal, root, generation);
        journal = await resources.transactions.update(transactionId, (current) => ({
          ...current,
          state: action === "roll-forward" ? "committed" : "rolled-back",
          updatedAt: this.now().toISOString(),
        }));
        await this.phase("recovery-completed", journal);
        const latest = await resources.changeSets.load(journal.changeSetId);
        const status = action === "roll-forward" ? "applied" : "reviewing";
        const recovered = await this.persistJournalState(resources, latest, journal, status, []);
        this.update({ changeSet: recovered, operation: null, problem: NO_PROBLEM });
        return completed(structuredClone(this.state));
      } catch (cause) {
        if (!root) {
          this.failOperation(cause, "stale-generation");
          throw cause;
        }
        const latestJournal = await resources.transactions.read(transactionId);
        const reconciled = await this.reconcileJournalWithSource(resources, latestJournal, root, action);
        const conflictPaths = reconciled.conflictPaths;
        const conflictedJournal = reconciled.journal;
        const latest = await resources.changeSets.load(journal.changeSetId);
        const interrupted = await this.persistJournalState(
          resources,
          latest,
          conflictedJournal,
          conflictPaths.length > 0 ? "conflicted" : latest.status,
          conflictPaths,
        );
        this.update({
          changeSet: interrupted,
          operation: null,
          problem: {
            code: conflictPaths.length > 0 ? "source-conflict" : "recovery-required",
            message: `Source recovery was interrupted: ${errorMessage(cause)}`,
            recoverable: true,
            ...(conflictPaths.length > 0 ? { paths: conflictPaths } : {}),
          },
        });
        return completed(structuredClone(this.state));
      } finally {
        lease.release();
      }
    }, options);
  }

  private serialize<T>(operation: () => Promise<T>, options: ChangeOperationOptions = {}): Promise<T> {
    if (!this.acceptingOperations) return Promise.reject(new Error("Change service is shutting down"));
    options.signal?.throwIfAborted();
    const run = async () => {
      options.signal?.throwIfAborted();
      return operation();
    };
    const result = this.operationTail.then(run, run);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private ensureProjectState(active: ActiveProject): void {
    if (
      this.state.projectGeneration === active.generation
      && this.state.projectInstanceKey === active.identity.instanceKey
    ) return;
    this.update({
      projectGeneration: active.generation,
      projectInstanceKey: active.identity.instanceKey,
      operation: null,
      changeSet: null,
      problem: NO_PROBLEM,
    });
  }

  private async hydrateProjectState(active: ActiveProject): Promise<void> {
    this.ensureProjectState(active);
    if (this.state.changeSet) return;

    const resources = await this.resourcesFor(active.identity.instanceKey);
    let current = await resources.changeSets.loadCurrent();
    if (!current) return;
    this.assertChangeSetProject(current, active);
    if (current.recovery?.actionRequired && current.application) {
      const journal = await resources.transactions.read(current.application.transactionId);
      this.assertJournalProject(journal, active, current.application.planDigest, true);
      this.assertJournalChangeSet(journal, current);
      const authorizedProject = await this.projects.authorizeSourceOperation(active.generation, active.identity.instanceKey);
      const root = await this.authorizeJournalRoot(journal, authorizedProject);
      const action: RecoveryAction = journal.state === "rolling-back" ? "roll-back" : "roll-forward";
      const reconciled = await this.reconcileJournalWithSource(resources, journal, root, action);
      const restoredStatus = reconciled.journal.state === "committed"
        ? "applied"
        : reconciled.journal.state === "rolled-back"
          ? "reviewing"
          : reconciled.conflictPaths.length > 0
            ? "conflicted"
            : current.status;
      current = await this.persistJournalState(
        resources,
        current,
        reconciled.journal,
        restoredStatus,
        reconciled.conflictPaths,
      );
    }
    this.update({ changeSet: current, problem: NO_PROBLEM });
  }

  private update(patch: Partial<Omit<ChangeWorkspaceSnapshot, "revision">>): void {
    this.workspaceRevision += 1;
    this.state = { ...this.state, ...patch, revision: this.workspaceRevision };
    const snapshot = structuredClone(this.state);
    for (const listener of this.listeners) listener(snapshot);
  }

  private failOperation(cause: unknown, code: ChangeProblem["code"]): void {
    this.update({
      operation: null,
      problem: { code, message: errorMessage(cause), recoverable: true },
    });
  }

  private async resourcesFor(instanceKey: string): Promise<ProjectResources> {
    let pending = this.resources.get(instanceKey);
    if (!pending) {
      pending = (async () => {
        const paths = await createWorkspacePaths(this.userDataPath, instanceKey);
        const blobs = await BlobStore.open(paths);
        return {
          paths,
          blobs,
          changeSets: await ChangeSetRepository.open(paths, blobs),
          scanner: await RuntimeChangeScanner.open(paths, blobs),
          transactions: await SourceTransactionRepository.create(paths.instanceRoot, instanceKey),
        };
      })();
      this.resources.set(instanceKey, pending);
      pending.catch(() => {
        if (this.resources.get(instanceKey) === pending) this.resources.delete(instanceKey);
      });
    }
    return pending;
  }

  private async requireWorkspace(active: ActiveProject): Promise<RuntimeWorkspace> {
    const workspace = await this.workspaces.current(active.identity);
    if (!workspace || !active.workspace) throw new Error("Prepare the runtime workspace before reviewing changes.");
    const resetWorkspace = this.resetWorkspaces.get(active.identity.instanceKey);
    if (
      resetWorkspace
      && workspace.runtimeId === resetWorkspace.runtimeId
      && workspace.baselineIdentity === resetWorkspace.baselineIdentity
    ) return workspace;
    if (
      workspace.baselineIdentity !== active.workspace.baselineIdentity
      || workspace.runtimeId !== active.workspace.runtimeId
    ) throw new Error("The active project references a stale runtime workspace.");
    this.resetWorkspaces.delete(active.identity.instanceKey);
    return workspace;
  }

  private async requireChangeSet(
    resources: ProjectResources,
    active: ActiveProject,
    id: string,
    expectedRevision: number,
  ): Promise<ChangeSetSnapshot> {
    const current = await resources.changeSets.load(id);
    this.assertChangeSetProject(current, active);
    if (current.revision !== expectedRevision) throw new Error(`Stale ChangeSet revision for ${id}.`);
    if (this.state.changeSet?.id === id && this.state.changeSet.revision !== current.revision) {
      throw new Error(`The visible ChangeSet revision is stale for ${id}.`);
    }
    return current;
  }

  private assertChangeSetProject(changeSet: ChangeSetSnapshot, active: ActiveProject): void {
    if (
      changeSet.projectId !== active.identity.projectId
      || changeSet.instanceKey !== active.identity.instanceKey
      || active.generation !== this.state.projectGeneration
    ) throw new Error("ChangeSet belongs to a different active project generation.");
  }

  private assertJournalProject(
    journal: SourceTransactionJournal,
    active: ActiveProject,
    planDigest: string,
    allowHistoricalGeneration: boolean,
  ): void {
    if (
      journal.instanceKey !== active.identity.instanceKey
      || journal.projectId !== active.identity.projectId
      || journal.planDigest !== planDigest
      || (!allowHistoricalGeneration && journal.projectGeneration !== active.generation)
    ) throw new Error("Source transaction does not belong to the active project or plan.");
  }

  private assertJournalChangeSet(journal: SourceTransactionJournal, changeSet: ChangeSetSnapshot): void {
    if (
      journal.changeSetId !== changeSet.id
      || journal.changeSetRevision > changeSet.revision
      || journal.instanceKey !== changeSet.instanceKey
      || journal.projectId !== changeSet.projectId
      || journal.baselineIdentity !== changeSet.baselineIdentity
      || journal.runtimeId !== changeSet.origin.runtimeId
      || changeSet.application?.transactionId !== journal.transactionId
      || changeSet.application.planDigest !== journal.planDigest
    ) throw new Error("Source transaction does not match its persisted ChangeSet.");
  }

  private async authorizeJournalRoot(
    journal: SourceTransactionJournal,
    active: ActiveProject,
  ): Promise<AuthorizedSourceRoot> {
    const root = await authorizeSourceRoot(active.identity.canonicalPath);
    if (journal.canonicalSourceRoot !== root.canonicalRoot) {
      throw new Error("The transaction source root no longer matches the active project.");
    }
    if (root.device !== journal.sourceRootDevice || root.inode !== journal.sourceRootInode) {
      throw new Error("The source root changed after transaction preparation.");
    }
    return root;
  }

  private async reauthorizeJournalRoot(
    generation: number,
    journal: SourceTransactionJournal,
  ): Promise<AuthorizedSourceRoot> {
    const active = await this.projects.authorizeSourceOperation(generation, journal.instanceKey);
    return this.authorizeJournalRoot(journal, active);
  }

  private async readDurableSource(
    blobs: BlobStore,
    root: AuthorizedSourceRoot,
    relativePath: string,
  ): Promise<SourceCapture> {
    const before = await readSourceLeaf(root, relativePath);
    if (before.kind === "absent") return { state: before, bytes: null };
    const captured = await blobs.captureFile(sourcePath(root, relativePath), root.canonicalRoot);
    const after = await readSourceLeaf(root, relativePath);
    if (!sameSourceState(before, after) || captured.identity.sha256 !== after.sha256 || captured.identity.byteLength !== after.size) {
      throw new SourceCompareAndSwapError(`Source changed during apply preparation: ${relativePath}`);
    }
    const bytes = await blobs.read(captured.identity, { maxBytes: DEFAULT_TEXT_DECODE_LIMITS.maxBytes });
    return { state: after, bytes };
  }

  private async readDecodedBlob(blobs: BlobStore, identity: ByteContentIdentity | null): Promise<DecodedTextFile> {
    if (!identity) return emptyDecoded();
    const bytes = await blobs.read(identity, { maxBytes: DEFAULT_TEXT_DECODE_LIMITS.maxBytes });
    const decoded = decodeTextFile(bytes);
    if (!decoded.ok) throw new Error(`Persisted text blob is no longer decodable: ${decoded.reason}`);
    return decoded.value;
  }

  private async prepareFile(
    blobs: BlobStore,
    root: AuthorizedSourceRoot,
    file: TextFileChange,
    selectedHunkIds: readonly string[],
  ): Promise<PreparedFile | null> {
    const [baseline, edited, source] = await Promise.all([
      this.readDecodedBlob(blobs, file.baseline),
      this.readDecodedBlob(blobs, file.edited),
      this.readDurableSource(blobs, root, file.path),
    ]);
    const diff = diffTextFiles(file.path, baseline, edited);
    validateStoredDiff(file, diff);
    if (!diff.ok) throw new Error(`Diff is too complex to apply: ${file.path}`);
    const selected = buildSelectedText(baseline, edited, diff.value, selectedHunkIds);
    if (!selected.ok) throw new Error(`Selected hunks are stale for ${file.path}: ${selected.reason}`);
    const fullDeletion = file.operation === "delete" && selectedHunkIds.length === file.hunks.length;
    let replacement = fullDeletion ? null : selected.bytes;
    const mode = source.state.mode ?? 0o644;
    const selectedResult = resultState(replacement, mode);
    if (sameSourceState(source.state, selectedResult)) {
      return {
        file,
        expected: source.state,
        result: selectedResult,
        operation: replacement ? "replace" : "delete",
        backup: source.bytes,
        replacement,
        mode: replacement ? mode : null,
        alreadySatisfied: true,
        createdDirectories: [],
      };
    }
    const baselineState = resultState(file.baseline ? await blobs.read(file.baseline, {
      maxBytes: DEFAULT_TEXT_DECODE_LIMITS.maxBytes,
    }) : null, source.state.mode);

    if (!sameSourceState(source.state, baselineState)) {
      if (!source.bytes) return null;
      const decodedSource = decodeTextFile(source.bytes);
      if (!decodedSource.ok) return null;
      const desired = decodeTextFile(replacement ?? EMPTY_BYTES);
      if (!desired.ok) return null;
      const merged = mergeTextFiles(baseline, decodedSource.value, desired.value);
      if (merged.kind !== "merged") return null;
      replacement = fullDeletion && merged.bytes.byteLength === 0 ? null : merged.bytes;
    }

    const result = resultState(replacement, mode);
    return {
      file,
      expected: source.state,
      result,
      operation: replacement ? "replace" : "delete",
      backup: source.bytes,
      replacement,
      mode: replacement ? mode : null,
      alreadySatisfied: sameSourceState(source.state, result),
      createdDirectories: replacement
        ? await findMissingSourceDirectories(root, file.path)
        : [],
    };
  }

  private preparedResult(snapshot: ChangeSetSnapshot, journal: SourceTransactionJournal): PreparedApplyResult {
    const selected = snapshot.selection.files.filter((file) => file.includeFile);
    return {
      status: "prepared",
      transactionId: journal.transactionId,
      planDigest: journal.planDigest,
      selectedFileCount: selected.length,
      selectedHunkCount: selected.reduce((count, file) => count + file.hunkIds.length, 0),
      conflictPaths: [],
      snapshot: structuredClone(this.state),
    };
  }

  private async reconcileJournalWithSource(
    resources: ProjectResources,
    journal: SourceTransactionJournal,
    root: AuthorizedSourceRoot,
    action: RecoveryAction,
  ): Promise<{ journal: SourceTransactionJournal; conflictPaths: readonly string[] }> {
    const assessment = await assessTransactionRecovery(journal, root);
    const byPath = new Map(assessment.files.map((file) => [file.path, file]));
    const conflictPaths = assessment.files
      .filter((file) => file.state === "unknown")
      .map((file) => file.path);
    const timestamp = this.now().toISOString();
    const reconciled = await resources.transactions.update(journal.transactionId, (current) => ({
      ...current,
      state: conflictPaths.length > 0 ? "conflicted" : current.state,
      updatedAt: timestamp,
      files: current.files.map((file) => {
        const fileAssessment = byPath.get(file.path);
        if (!fileAssessment) throw new Error(`Recovery assessment omitted ${file.path}.`);
        const outcome = reconciledFileState(file, fileAssessment, action);
        const { message: _previousMessage, ...withoutMessage } = file;
        void _previousMessage;
        return {
          ...withoutMessage,
          state: outcome.state,
          ...(outcome.message ? { message: outcome.message } : {}),
        };
      }),
    }));
    return { journal: reconciled, conflictPaths };
  }

  private async applyForward(
    resources: ProjectResources,
    initial: SourceTransactionJournal,
    root: AuthorizedSourceRoot,
    generation: number,
  ): Promise<SourceTransactionJournal> {
    let journal = initial;
    for (const original of journal.files) {
      root = await this.reauthorizeJournalRoot(generation, journal);
      const currentFile = journal.files.find((file) => file.path === original.path)!;
      const current = await readSourceLeaf(root, currentFile.path);
      if (sameSourceState(current, currentFile.result)) {
        journal = await this.updateJournalFile(resources, journal, currentFile.path, (file) => ({
          ...file,
          state: file.state === "applied" ? "applied" : "already-satisfied",
        }));
        continue;
      }
      if (!sameSourceState(current, currentFile.expected)) {
        journal = await this.updateJournalFile(resources, journal, currentFile.path, (file) => ({
          ...file,
          state: "conflicted",
          message: "Source no longer matches the prepared input or result.",
        }));
        throw new SourceCompareAndSwapError(`Source changed during apply: ${currentFile.path}`);
      }
      const operation = await this.forwardOperation(resources.transactions, journal, currentFile);
      const result = await writeSourceFileSecurely({
        root,
        relativePath: currentFile.path,
        expected: currentFile.expected,
        operation,
        plannedDirectories: currentFile.plannedDirectories,
        ...(currentFile.temporaryName ? { temporaryName: currentFile.temporaryName } : {}),
        onDirectoriesCreated: async (directories) => {
          if (directories.some((directory) => !currentFile.plannedDirectories.includes(directory))) {
            throw new Error(`Created directories exceeded the prepared plan: ${currentFile.path}`);
          }
          journal = await this.updateJournalFile(resources, journal, currentFile.path, (file) => ({
            ...file,
            createdDirectories: [...directories],
          }));
          await this.phase("directories-recorded", journal);
        },
        onIntentDurable: async () => {
          journal = await this.updateJournalFile(resources, journal, currentFile.path, (file) => ({
            ...file,
            state: "replacement-intent",
          }));
          await this.phase("file-intent-recorded", journal);
        },
        onSourceDurable: async () => {
          await this.phase("file-source-durable", journal);
        },
      });
      if (!sameSourceState(result.after, currentFile.result)) {
        throw new Error(`Durable source result did not match the prepared plan: ${currentFile.path}`);
      }
      journal = await this.updateJournalFile(resources, journal, currentFile.path, (file) => ({
        ...file,
        state: "applied",
        createdDirectories: result.createdDirectories,
      }));
      await this.phase("file-state-recorded", journal);
      await this.persistProgress(resources, journal);
    }
    return journal;
  }

  private async applyRollback(
    resources: ProjectResources,
    initial: SourceTransactionJournal,
    root: AuthorizedSourceRoot,
    generation: number,
  ): Promise<SourceTransactionJournal> {
    let journal = initial;
    for (const original of [...journal.files].reverse()) {
      root = await this.reauthorizeJournalRoot(generation, journal);
      const currentFile = journal.files.find((file) => file.path === original.path)!;
      const current = await readSourceLeaf(root, currentFile.path);
      if (sameSourceState(current, currentFile.expected)) {
        await removePreparedTemporaryFile(root, currentFile.path, currentFile.temporaryName);
        journal = await this.updateJournalFile(resources, journal, currentFile.path, (file) => ({ ...file, state: "rolled-back" }));
        await removeCreatedDirectories(root, currentFile.createdDirectories);
        continue;
      }
      if (!sameSourceState(current, currentFile.result)) {
        journal = await this.updateJournalFile(resources, journal, currentFile.path, (file) => ({
          ...file,
          state: "rollback-conflict",
          message: "Source no longer matches the transaction result or backup.",
        }));
        throw new SourceCompareAndSwapError(`Source changed before rollback: ${currentFile.path}`);
      }
      const operation = await this.rollbackOperation(resources.transactions, journal, currentFile);
      const result = await writeSourceFileSecurely({
        root,
        relativePath: currentFile.path,
        expected: currentFile.result,
        operation,
        plannedDirectories: [],
        ...(currentFile.temporaryName ? { temporaryName: currentFile.temporaryName } : {}),
        onIntentDurable: async () => {
          journal = await this.updateJournalFile(resources, journal, currentFile.path, (file) => ({
            ...file,
            state: "replacement-intent",
          }));
          await this.phase("file-intent-recorded", journal);
        },
        onSourceDurable: async () => {
          await this.phase("file-source-durable", journal);
        },
      });
      if (!sameSourceState(result.after, currentFile.expected)) {
        throw new Error(`Rollback result did not match the prepared backup: ${currentFile.path}`);
      }
      await removeCreatedDirectories(root, currentFile.createdDirectories);
      journal = await this.updateJournalFile(resources, journal, currentFile.path, (file) => ({ ...file, state: "rolled-back" }));
      await this.phase("file-state-recorded", journal);
      await this.persistProgress(resources, journal);
    }
    return journal;
  }

  private async forwardOperation(
    transactions: SourceTransactionRepository,
    journal: SourceTransactionJournal,
    file: SourceTransactionFile,
  ): Promise<SourceWriteOperation> {
    if (file.operation === "delete") return { kind: "delete" };
    if (!file.replacement) throw new Error(`Replacement blob is missing for ${file.path}.`);
    return {
      kind: "replace",
      bytes: await transactions.readBlob(journal.transactionId, file.replacement),
      ...(file.mode !== null ? { mode: file.mode } : {}),
    };
  }

  private async rollbackOperation(
    transactions: SourceTransactionRepository,
    journal: SourceTransactionJournal,
    file: SourceTransactionFile,
  ): Promise<SourceWriteOperation> {
    if (file.expected.kind === "absent") return { kind: "delete" };
    if (!file.backup) throw new Error(`Backup blob is missing for ${file.path}.`);
    return {
      kind: "replace",
      bytes: await transactions.readBlob(journal.transactionId, file.backup),
      ...(file.expected.mode !== null ? { mode: file.expected.mode } : {}),
    };
  }

  private async updateJournalFile(
    resources: ProjectResources,
    journal: SourceTransactionJournal,
    pathValue: string,
    mutator: (file: SourceTransactionFile) => SourceTransactionFile,
  ): Promise<SourceTransactionJournal> {
    return resources.transactions.update(journal.transactionId, (current) =>
      replaceJournalFile(current, pathValue, mutator, this.now().toISOString()),
    );
  }

  private async persistProgress(resources: ProjectResources, journal: SourceTransactionJournal): Promise<void> {
    const latest = await resources.changeSets.load(journal.changeSetId);
    const next = await this.persistJournalState(resources, latest, journal, latest.status, []);
    this.update({ changeSet: next });
  }

  private async persistJournalState(
    resources: ProjectResources,
    current: ChangeSetSnapshot,
    journal: SourceTransactionJournal,
    status: ChangeSetSnapshot["status"],
    conflictPaths: readonly string[],
  ): Promise<ChangeSetSnapshot> {
    return resources.changeSets.update({
      ...current,
      revision: current.revision + 1,
      status,
      updatedAt: this.now().toISOString(),
      application: applicationFromJournal(current, journal),
      recovery: journalRecovery(journal, conflictPaths),
    }, current.revision);
  }

  private async phase(phase: ChangeTransactionPhase, journal: SourceTransactionJournal): Promise<void> {
    await this.onTransactionPhase?.(phase, structuredClone(journal));
  }
}
