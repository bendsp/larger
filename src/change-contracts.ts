export const CHANGE_SET_FORMAT_VERSION = 1 as const;

export type ChangeSetStatus =
  | "detected"
  | "reviewing"
  | "applying"
  | "applied"
  | "conflicted"
  | "discarded"
  | "failed";

export type FileOperation = "add" | "modify" | "delete";

export interface ChangeOrigin {
  readonly kind: "runtime-workspace";
  readonly runtimeId: string;
}

export interface ByteContentIdentity {
  readonly hashAlgorithm: "sha256";
  readonly sha256: string;
  readonly byteLength: number;
}

export type LineTerminator = "lf" | "crlf" | "cr" | "none";
export type LineEndingStyle = LineTerminator | "mixed";

export interface TextContentMetadata extends ByteContentIdentity {
  readonly encoding: "utf-8";
  readonly bom: "none" | "utf-8";
  readonly lineEndings: LineEndingStyle;
  readonly lineCount: number;
}

export interface TextLineToken {
  readonly content: string;
  readonly terminator: LineTerminator;
}

/** A half-open replacement in zero-based baseline line coordinates. */
export interface TextEdit {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly replacement: readonly TextLineToken[];
}

export interface DiffDisplayLine {
  readonly kind: "context" | "addition" | "deletion";
  readonly content: string;
  readonly terminator: LineTerminator;
  readonly oldLineNumber: number | null;
  readonly newLineNumber: number | null;
}

export interface TextChangeHunk {
  readonly kind: "text";
  readonly id: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly edits: readonly TextEdit[];
  readonly lines: readonly DiffDisplayLine[];
}

export interface BomChangeHunk {
  readonly kind: "bom";
  readonly id: string;
  readonly baseline: "none" | "utf-8";
  readonly edited: "none" | "utf-8";
}

export type ChangeHunk = TextChangeHunk | BomChangeHunk;

export interface PossibleRenameHint {
  readonly kind: "possible-rename";
  readonly otherPath: string;
  readonly confidence: "exact-content";
}

export interface TextFileChange {
  readonly kind: "text";
  readonly id: string;
  readonly path: string;
  readonly operation: FileOperation;
  readonly baseline: TextContentMetadata | null;
  readonly edited: TextContentMetadata | null;
  readonly hunks: readonly ChangeHunk[];
  readonly possibleRename: PossibleRenameHint | null;
}

export type UnsupportedChangeReason =
  | "binary"
  | "unsupported-encoding"
  | "file-too-large"
  | "too-many-lines"
  | "line-too-long"
  | "diff-too-complex"
  | "symlink"
  | "special-file"
  | "mode-change"
  | "unstable-read";

export interface UnsupportedFileChange {
  readonly kind: "unsupported";
  readonly id: string;
  readonly path: string;
  readonly operation: FileOperation;
  readonly reason: UnsupportedChangeReason;
  readonly baseline: ByteContentIdentity | null;
  readonly edited: ByteContentIdentity | null;
  readonly possibleRename: PossibleRenameHint | null;
}

export type ChangeFile = TextFileChange | UnsupportedFileChange;

export interface FileHunkSelection {
  readonly fileId: string;
  readonly includeFile: boolean;
  readonly hunkIds: readonly string[];
}

export interface ChangeSelection {
  readonly files: readonly FileHunkSelection[];
}

export type FileApplicationOutcome =
  | "pending"
  | "not-selected"
  | "applied"
  | "already-satisfied"
  | "conflicted"
  | "unsupported"
  | "rolled-back"
  | "rollback-conflict";

export interface FileApplicationResult {
  readonly path: string;
  readonly outcome: FileApplicationOutcome;
  readonly sourceBeforeSha256: string | null;
  readonly sourceAfterSha256: string | null;
}

export interface ChangeApplicationSummary {
  readonly transactionId: string;
  readonly planDigest: string;
  readonly files: readonly FileApplicationResult[];
}

export type RecoveryAction = "roll-forward" | "roll-back";

export interface ChangeRecoveryMetadata {
  readonly transactionId: string;
  readonly actionRequired: boolean;
  readonly availableActions: readonly RecoveryAction[];
  readonly appliedCount: number;
  readonly pendingCount: number;
  readonly conflictPaths: readonly string[];
}

export interface ChangeSetSnapshot {
  readonly formatVersion: typeof CHANGE_SET_FORMAT_VERSION;
  readonly id: string;
  readonly revision: number;
  readonly projectId: string;
  readonly instanceKey: string;
  readonly baselineIdentity: string;
  readonly origin: ChangeOrigin;
  readonly status: ChangeSetStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly files: readonly ChangeFile[];
  readonly selection: ChangeSelection;
  readonly application: ChangeApplicationSummary | null;
  readonly recovery: ChangeRecoveryMetadata | null;
}
