import type { TextEdit, TextLineToken } from "../../src/change-contracts.js";
import {
  DEFAULT_TEXT_DIFF_LIMITS,
  diffTextEdits,
  type TextDiffLimits,
} from "./diff-engine.js";
import { applyTextEdits } from "./selection.js";
import type { DecodedTextFile } from "./text-codec.js";
import { decodeTextFile, encodeTextFile, textLineEquals } from "./text-codec.js";

export type MergeConflictReason =
  | "overlapping-change"
  | "same-anchor-insertion"
  | "insertion-overlaps-change";

export interface TextMergeConflict {
  readonly reason: MergeConflictReason;
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly sourceEdit: TextEdit;
  readonly desiredEdit: TextEdit;
}

export type ThreeWayTextMergeResult =
  | {
    readonly kind: "merged";
    readonly bytes: Uint8Array;
    readonly value: DecodedTextFile;
    readonly sourceEdits: readonly TextEdit[];
    readonly desiredEdits: readonly TextEdit[];
    readonly mergedEdits: readonly TextEdit[];
  }
  | {
    readonly kind: "conflicted";
    readonly conflicts: readonly TextMergeConflict[];
    readonly sourceEdits: readonly TextEdit[];
    readonly desiredEdits: readonly TextEdit[];
  }
  | { readonly kind: "failed"; readonly reason: "diff-too-complex" };

function replacementEquals(left: readonly TextLineToken[], right: readonly TextLineToken[]): boolean {
  return left.length === right.length && left.every((token, index) => {
    const other = right[index];
    return other !== undefined && textLineEquals(token, other);
  });
}

function editEquals(left: TextEdit, right: TextEdit): boolean {
  return left.baseStart === right.baseStart
    && left.baseEnd === right.baseEnd
    && replacementEquals(left.replacement, right.replacement);
}

function conflictReason(source: TextEdit, desired: TextEdit): MergeConflictReason | undefined {
  const sourceInsertion = source.baseStart === source.baseEnd;
  const desiredInsertion = desired.baseStart === desired.baseEnd;

  if (sourceInsertion && desiredInsertion) {
    return source.baseStart === desired.baseStart ? "same-anchor-insertion" : undefined;
  }
  if (sourceInsertion) {
    return source.baseStart >= desired.baseStart && source.baseStart <= desired.baseEnd
      ? "insertion-overlaps-change"
      : undefined;
  }
  if (desiredInsertion) {
    return desired.baseStart >= source.baseStart && desired.baseStart <= source.baseEnd
      ? "insertion-overlaps-change"
      : undefined;
  }

  return Math.max(source.baseStart, desired.baseStart) < Math.min(source.baseEnd, desired.baseEnd)
    ? "overlapping-change"
    : undefined;
}

function mergeBom(
  baseline: DecodedTextFile,
  source: DecodedTextFile,
  desired: DecodedTextFile,
): DecodedTextFile["metadata"]["bom"] {
  if (source.metadata.bom === baseline.metadata.bom) return desired.metadata.bom;
  if (desired.metadata.bom === baseline.metadata.bom) return source.metadata.bom;
  return source.metadata.bom;
}

export function mergeTextFiles(
  baseline: DecodedTextFile,
  source: DecodedTextFile,
  desired: DecodedTextFile,
  limits: TextDiffLimits = DEFAULT_TEXT_DIFF_LIMITS,
): ThreeWayTextMergeResult {
  const sourceEdits = diffTextEdits(baseline.lines, source.lines, limits);
  const desiredEdits = diffTextEdits(baseline.lines, desired.lines, limits);
  if (!sourceEdits || !desiredEdits) return { kind: "failed", reason: "diff-too-complex" };

  const conflicts: TextMergeConflict[] = [];
  for (const sourceEdit of sourceEdits) {
    for (const desiredEdit of desiredEdits) {
      if (editEquals(sourceEdit, desiredEdit)) continue;
      const reason = conflictReason(sourceEdit, desiredEdit);
      if (!reason) continue;
      conflicts.push(Object.freeze({
        reason,
        baseStart: Math.min(sourceEdit.baseStart, desiredEdit.baseStart),
        baseEnd: Math.max(sourceEdit.baseEnd, desiredEdit.baseEnd),
        sourceEdit,
        desiredEdit,
      }));
    }
  }

  if (conflicts.length > 0) {
    return {
      kind: "conflicted",
      conflicts: Object.freeze(conflicts),
      sourceEdits,
      desiredEdits,
    };
  }

  const mergedEdits: TextEdit[] = [...sourceEdits];
  for (const desiredEdit of desiredEdits) {
    if (!mergedEdits.some((sourceEdit) => editEquals(sourceEdit, desiredEdit))) mergedEdits.push(desiredEdit);
  }
  mergedEdits.sort((left, right) => left.baseStart - right.baseStart || left.baseEnd - right.baseEnd);

  const lines = applyTextEdits(baseline.lines, mergedEdits);
  if (!lines) throw new Error("Non-conflicting merge edits produced an invalid edit set.");

  const metadata = Object.freeze({
    ...baseline.metadata,
    bom: mergeBom(baseline, source, desired),
  });
  const bytes = encodeTextFile({ metadata, lines });
  const decoded = decodeTextFile(bytes);
  if (!decoded.ok) throw new Error(`Merged text could not be decoded: ${decoded.reason}`);

  return {
    kind: "merged",
    bytes,
    value: decoded.value,
    sourceEdits,
    desiredEdits,
    mergedEdits: Object.freeze(mergedEdits),
  };
}
