import { z } from "zod";
import type { ChangeSelection, ChangeSetSnapshot, RecoveryAction } from "./change-contracts";

export const CHANGE_IPC_CHANNELS = {
  snapshot: "changes:snapshot",
  getSnapshot: "changes:get-snapshot",
  scan: "changes:scan",
  updateSelection: "changes:update-selection",
  prepareApply: "changes:prepare-apply",
  commitApply: "changes:commit-apply",
  discard: "changes:discard",
  recover: "changes:recover",
} as const;

export interface ChangeProblem {
  readonly code:
    | "no-active-project"
    | "workspace-required"
    | "stale-generation"
    | "stale-revision"
    | "unsupported-change"
    | "source-conflict"
    | "recovery-required"
    | "internal";
  readonly message: string;
  readonly recoverable: boolean;
  readonly paths?: readonly string[];
}

export interface ChangeWorkspaceSnapshot {
  readonly revision: number;
  readonly projectGeneration: number | null;
  readonly projectInstanceKey: string | null;
  readonly operation: null | {
    readonly kind: "scanning" | "preparing-apply" | "applying" | "discarding" | "recovering";
    readonly transactionId?: string;
  };
  readonly changeSet: ChangeSetSnapshot | null;
  readonly problem: ChangeProblem | null;
}

export type ChangeOperationResult =
  | { readonly status: "completed"; readonly snapshot: ChangeWorkspaceSnapshot }
  | { readonly status: "cancelled"; readonly snapshot: ChangeWorkspaceSnapshot };

export interface PreparedApplyResult {
  readonly status: "prepared" | "conflicted";
  readonly transactionId: string | null;
  readonly planDigest: string | null;
  readonly selectedFileCount: number;
  readonly selectedHunkCount: number;
  readonly conflictPaths: readonly string[];
  readonly snapshot: ChangeWorkspaceSnapshot;
}

export interface LargerChangesBridge {
  getSnapshot(generation: number): Promise<ChangeWorkspaceSnapshot>;
  scan(generation: number): Promise<ChangeOperationResult>;
  updateSelection(
    generation: number,
    changeSetId: string,
    expectedRevision: number,
    selection: ChangeSelection,
  ): Promise<ChangeOperationResult>;
  prepareApply(generation: number, changeSetId: string, expectedRevision: number): Promise<PreparedApplyResult>;
  commitApply(generation: number, transactionId: string, planDigest: string): Promise<ChangeOperationResult>;
  discard(
    generation: number,
    changeSetId: string,
    expectedRevision: number,
    confirmUnappliedLoss: true,
  ): Promise<ChangeOperationResult>;
  recover(generation: number, transactionId: string, action: RecoveryAction): Promise<ChangeOperationResult>;
  onSnapshot(listener: (snapshot: ChangeWorkspaceSnapshot) => void): () => void;
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const contentIdentitySchema = z.object({
  hashAlgorithm: z.literal("sha256"),
  sha256: sha256Schema,
  byteLength: z.number().int().nonnegative(),
}).strict();
const terminatorSchema = z.enum(["lf", "crlf", "cr", "none"]);
const textMetadataSchema = contentIdentitySchema.extend({
  encoding: z.literal("utf-8"),
  bom: z.enum(["none", "utf-8"]),
  lineEndings: z.enum(["lf", "crlf", "cr", "none", "mixed"]),
  lineCount: z.number().int().nonnegative(),
}).strict();
const tokenSchema = z.object({ content: z.string(), terminator: terminatorSchema }).strict();
const editSchema = z.object({
  baseStart: z.number().int().nonnegative(),
  baseEnd: z.number().int().nonnegative(),
  replacement: z.array(tokenSchema),
}).strict();
const displayLineSchema = z.object({
  kind: z.enum(["context", "addition", "deletion"]),
  content: z.string(),
  terminator: terminatorSchema,
  oldLineNumber: z.number().int().positive().nullable(),
  newLineNumber: z.number().int().positive().nullable(),
}).strict();
const hunkSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    id: sha256Schema,
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    edits: z.array(editSchema),
    lines: z.array(displayLineSchema),
  }).strict(),
  z.object({
    kind: z.literal("bom"),
    id: sha256Schema,
    baseline: z.enum(["none", "utf-8"]),
    edited: z.enum(["none", "utf-8"]),
  }).strict(),
]);
const possibleRenameSchema = z.object({
  kind: z.literal("possible-rename"),
  otherPath: z.string(),
  confidence: z.literal("exact-content"),
}).strict();
const fileSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    id: sha256Schema,
    path: z.string(),
    operation: z.enum(["add", "modify", "delete"]),
    baseline: textMetadataSchema.nullable(),
    edited: textMetadataSchema.nullable(),
    hunks: z.array(hunkSchema),
    possibleRename: possibleRenameSchema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal("unsupported"),
    id: sha256Schema,
    path: z.string(),
    operation: z.enum(["add", "modify", "delete"]),
    reason: z.enum(["binary", "unsupported-encoding", "file-too-large", "too-many-lines", "line-too-long", "diff-too-complex", "symlink", "special-file", "mode-change", "unstable-read"]),
    baseline: contentIdentitySchema.nullable(),
    edited: contentIdentitySchema.nullable(),
    possibleRename: possibleRenameSchema.nullable(),
  }).strict(),
]);
const selectionSchema = z.object({
  files: z.array(z.object({ fileId: sha256Schema, includeFile: z.boolean(), hunkIds: z.array(sha256Schema) }).strict()),
}).strict();
const applicationSchema = z.object({
  transactionId: z.string().uuid(),
  planDigest: sha256Schema,
  files: z.array(z.object({
    path: z.string(),
    outcome: z.enum(["pending", "not-selected", "applied", "already-satisfied", "conflicted", "unsupported", "rolled-back", "rollback-conflict"]),
    sourceBeforeSha256: sha256Schema.nullable(),
    sourceAfterSha256: sha256Schema.nullable(),
  }).strict()),
}).strict();
const recoverySchema = z.object({
  transactionId: z.string().uuid(),
  actionRequired: z.boolean(),
  availableActions: z.array(z.enum(["roll-forward", "roll-back"])),
  appliedCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  conflictPaths: z.array(z.string()),
}).strict();

export const changeSetSnapshotSchema: z.ZodType<ChangeSetSnapshot> = z.object({
  formatVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  projectId: z.string().min(1),
  instanceKey: z.string().min(1),
  baselineIdentity: z.string().min(1),
  origin: z.object({ kind: z.literal("runtime-workspace"), runtimeId: z.string().min(1) }).strict(),
  status: z.enum(["detected", "reviewing", "applying", "applied", "conflicted", "discarded", "failed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  files: z.array(fileSchema),
  selection: selectionSchema,
  application: applicationSchema.nullable(),
  recovery: recoverySchema.nullable(),
}).strict();

const problemSchema = z.object({
  code: z.enum(["no-active-project", "workspace-required", "stale-generation", "stale-revision", "unsupported-change", "source-conflict", "recovery-required", "internal"]),
  message: z.string(),
  recoverable: z.boolean(),
  paths: z.array(z.string()).optional(),
}).strict();

export const changeWorkspaceSnapshotSchema: z.ZodType<ChangeWorkspaceSnapshot> = z.object({
  revision: z.number().int().nonnegative(),
  projectGeneration: z.number().int().nonnegative().nullable(),
  projectInstanceKey: z.string().nullable(),
  operation: z.object({
    kind: z.enum(["scanning", "preparing-apply", "applying", "discarding", "recovering"]),
    transactionId: z.string().uuid().optional(),
  }).strict().nullable(),
  changeSet: changeSetSnapshotSchema.nullable(),
  problem: problemSchema.nullable(),
}).strict();

export const changeOperationResultSchema: z.ZodType<ChangeOperationResult> = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), snapshot: changeWorkspaceSnapshotSchema }).strict(),
  z.object({ status: z.literal("cancelled"), snapshot: changeWorkspaceSnapshotSchema }).strict(),
]);

export const preparedApplyResultSchema: z.ZodType<PreparedApplyResult> = z.object({
  status: z.enum(["prepared", "conflicted"]),
  transactionId: z.string().uuid().nullable(),
  planDigest: sha256Schema.nullable(),
  selectedFileCount: z.number().int().nonnegative(),
  selectedHunkCount: z.number().int().nonnegative(),
  conflictPaths: z.array(z.string()),
  snapshot: changeWorkspaceSnapshotSchema,
}).strict();

export const changeGenerationInputSchema = z.object({ generation: z.number().int().nonnegative() }).strict();
export const changeSelectionInputSchema = z.object({
  generation: z.number().int().nonnegative(),
  changeSetId: z.string().min(1).max(256),
  expectedRevision: z.number().int().nonnegative(),
  selection: selectionSchema,
}).strict();
export const changeSetMutationInputSchema = z.object({
  generation: z.number().int().nonnegative(),
  changeSetId: z.string().min(1).max(256),
  expectedRevision: z.number().int().nonnegative(),
}).strict();
export const commitApplyInputSchema = z.object({
  generation: z.number().int().nonnegative(),
  transactionId: z.string().uuid(),
  planDigest: sha256Schema,
}).strict();
export const discardInputSchema = changeSetMutationInputSchema.extend({ confirmUnappliedLoss: z.literal(true) }).strict();
export const recoverInputSchema = z.object({
  generation: z.number().int().nonnegative(),
  transactionId: z.string().uuid(),
  action: z.enum(["roll-forward", "roll-back"]),
}).strict();
