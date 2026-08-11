import type { TextEdit, TextLineToken } from "../../src/change-contracts.js";
import type { TextFileDiff } from "./diff-engine.js";
import type { DecodedTextFile } from "./text-codec.js";
import { decodeTextFile, encodeTextFile } from "./text-codec.js";

export type TextSelectionFailureReason =
  | "stale-baseline"
  | "stale-edited"
  | "unknown-hunk"
  | "invalid-edit-set";

export type TextSelectionResult =
  | {
    readonly ok: true;
    readonly bytes: Uint8Array;
    readonly value: DecodedTextFile;
    readonly selectedHunkIds: readonly string[];
  }
  | { readonly ok: false; readonly reason: TextSelectionFailureReason };

function cloneToken(token: TextLineToken): TextLineToken {
  return Object.freeze({ content: token.content, terminator: token.terminator });
}

function editsAreValid(edits: readonly TextEdit[], baselineLength: number): boolean {
  let previous: TextEdit | undefined;
  for (const edit of edits) {
    if (!Number.isSafeInteger(edit.baseStart)
      || !Number.isSafeInteger(edit.baseEnd)
      || edit.baseStart < 0
      || edit.baseEnd < edit.baseStart
      || edit.baseEnd > baselineLength) return false;

    if (previous) {
      const overlaps = previous.baseEnd > edit.baseStart;
      const ambiguousSharedInsertion = previous.baseStart === edit.baseStart
        && (previous.baseStart === previous.baseEnd || edit.baseStart === edit.baseEnd);
      if (overlaps || ambiguousSharedInsertion) return false;
    }
    previous = edit;
  }
  return true;
}

export function applyTextEdits(
  baseline: readonly TextLineToken[],
  inputEdits: readonly TextEdit[],
): readonly TextLineToken[] | undefined {
  const edits = [...inputEdits].sort((left, right) => left.baseStart - right.baseStart || left.baseEnd - right.baseEnd);
  if (!editsAreValid(edits, baseline.length)) return undefined;

  const result: TextLineToken[] = [];
  let cursor = 0;
  for (const edit of edits) {
    result.push(...baseline.slice(cursor, edit.baseStart).map(cloneToken));
    result.push(...edit.replacement.map(cloneToken));
    cursor = edit.baseEnd;
  }
  result.push(...baseline.slice(cursor).map(cloneToken));
  return Object.freeze(result);
}

export function buildSelectedText(
  baseline: DecodedTextFile,
  edited: DecodedTextFile,
  diff: TextFileDiff,
  selectedIds: Iterable<string>,
): TextSelectionResult {
  if (diff.baseline.sha256 !== baseline.metadata.sha256) return { ok: false, reason: "stale-baseline" };
  if (diff.edited.sha256 !== edited.metadata.sha256) return { ok: false, reason: "stale-edited" };

  const selected = new Set(selectedIds);
  const known = new Set(diff.hunks.map((hunk) => hunk.id));
  if ([...selected].some((id) => !known.has(id))) return { ok: false, reason: "unknown-hunk" };

  const selectedHunks = diff.hunks.filter((hunk) => selected.has(hunk.id));
  const selectedEdits = selectedHunks.flatMap((hunk) => hunk.kind === "text" ? [...hunk.edits] : []);
  const lines = applyTextEdits(baseline.lines, selectedEdits);
  if (!lines) return { ok: false, reason: "invalid-edit-set" };

  const selectedBom = selectedHunks.find((hunk) => hunk.kind === "bom");
  const metadata = Object.freeze({
    ...baseline.metadata,
    bom: selectedBom?.kind === "bom" ? selectedBom.edited : baseline.metadata.bom,
  });
  const bytes = encodeTextFile({ metadata, lines });
  const decoded = decodeTextFile(bytes);
  if (!decoded.ok) throw new Error(`Selected text could not be decoded: ${decoded.reason}`);

  return {
    ok: true,
    bytes,
    value: decoded.value,
    selectedHunkIds: Object.freeze(diff.hunks.filter((hunk) => selected.has(hunk.id)).map((hunk) => hunk.id)),
  };
}
