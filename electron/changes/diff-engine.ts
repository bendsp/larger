import { createHash } from "node:crypto";

import { diffArrays } from "diff";

import type {
  BomChangeHunk,
  ChangeHunk,
  DiffDisplayLine,
  TextChangeHunk,
  TextContentMetadata,
  TextEdit,
  TextLineToken,
} from "../../src/change-contracts.js";
import type { DecodedTextFile } from "./text-codec.js";
import { textLineEquals } from "./text-codec.js";

export interface TextDiffLimits {
  readonly maxEditLength: number;
  readonly timeoutMs: number;
  readonly contextLines: number;
}

export const DEFAULT_TEXT_DIFF_LIMITS: TextDiffLimits = Object.freeze({
  maxEditLength: 20_000,
  timeoutMs: 1_000,
  contextLines: 3,
});

export interface TextFileDiff {
  readonly path: string;
  readonly baseline: TextContentMetadata;
  readonly edited: TextContentMetadata;
  readonly edits: readonly TextEdit[];
  readonly hunks: readonly ChangeHunk[];
}

export type TextFileDiffResult =
  | { readonly ok: true; readonly value: TextFileDiff }
  | { readonly ok: false; readonly reason: "diff-too-complex" };

function cloneToken(token: TextLineToken): TextLineToken {
  return Object.freeze({ content: token.content, terminator: token.terminator });
}

function freezeEdit(baseStart: number, baseEnd: number, replacement: readonly TextLineToken[]): TextEdit {
  return Object.freeze({
    baseStart,
    baseEnd,
    replacement: Object.freeze(replacement.map(cloneToken)),
  });
}

function computeEdits(
  baseline: readonly TextLineToken[],
  edited: readonly TextLineToken[],
  limits: TextDiffLimits,
): readonly TextEdit[] | undefined {
  const changes = diffArrays([...baseline], [...edited], {
    comparator: textLineEquals,
    maxEditLength: limits.maxEditLength,
    timeout: limits.timeoutMs,
  });
  if (!changes) return undefined;

  const edits: TextEdit[] = [];
  let baseCursor = 0;
  let pendingStart: number | null = null;
  let pendingEnd = 0;
  let pendingReplacement: TextLineToken[] = [];

  const flush = () => {
    if (pendingStart === null) return;
    edits.push(freezeEdit(pendingStart, pendingEnd, pendingReplacement));
    pendingStart = null;
    pendingEnd = 0;
    pendingReplacement = [];
  };

  for (const change of changes) {
    if (!change.added && !change.removed) {
      flush();
      baseCursor += change.value.length;
      continue;
    }

    if (pendingStart === null) {
      pendingStart = baseCursor;
      pendingEnd = baseCursor;
    }
    if (change.removed) {
      pendingEnd = baseCursor + change.value.length;
      baseCursor = pendingEnd;
    } else {
      pendingReplacement.push(...change.value);
    }
  }
  flush();

  return Object.freeze(edits);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function groupEdits(edits: readonly TextEdit[], contextLines: number): readonly (readonly TextEdit[])[] {
  const groups: TextEdit[][] = [];

  for (const edit of edits) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    if (!current || !previous || edit.baseStart - previous.baseEnd > contextLines * 2) {
      groups.push([edit]);
    } else {
      current.push(edit);
    }
  }

  return Object.freeze(groups.map((group) => Object.freeze(group)));
}

function newPositionBefore(baseIndex: number, edits: readonly TextEdit[]): number {
  let position = baseIndex;
  for (const edit of edits) {
    if (edit.baseStart >= baseIndex) break;
    if (edit.baseEnd <= baseIndex) position += edit.replacement.length - (edit.baseEnd - edit.baseStart);
  }
  return position;
}

function displayLine(
  kind: DiffDisplayLine["kind"],
  token: TextLineToken,
  oldLineNumber: number | null,
  newLineNumber: number | null,
): DiffDisplayLine {
  return Object.freeze({
    kind,
    content: token.content,
    terminator: token.terminator,
    oldLineNumber,
    newLineNumber,
  });
}

function createTextHunk(
  path: string,
  group: readonly TextEdit[],
  allEdits: readonly TextEdit[],
  baseline: readonly TextLineToken[],
  contextLines: number,
): TextChangeHunk {
  const first = group[0];
  const last = group[group.length - 1];
  if (!first || !last) throw new Error("Cannot create an empty diff hunk.");

  const windowStart = Math.max(0, first.baseStart - contextLines);
  const windowEnd = Math.min(baseline.length, last.baseEnd + contextLines);
  let baseCursor = windowStart;
  let newCursor = newPositionBefore(windowStart, allEdits);
  const lines: DiffDisplayLine[] = [];

  for (const edit of group) {
    while (baseCursor < edit.baseStart) {
      const token = baseline[baseCursor];
      if (!token) throw new Error("Diff context exceeded the baseline.");
      lines.push(displayLine("context", token, baseCursor + 1, newCursor + 1));
      baseCursor += 1;
      newCursor += 1;
    }

    while (baseCursor < edit.baseEnd) {
      const token = baseline[baseCursor];
      if (!token) throw new Error("Diff deletion exceeded the baseline.");
      lines.push(displayLine("deletion", token, baseCursor + 1, null));
      baseCursor += 1;
    }

    for (const token of edit.replacement) {
      lines.push(displayLine("addition", token, null, newCursor + 1));
      newCursor += 1;
    }
  }

  while (baseCursor < windowEnd) {
    const token = baseline[baseCursor];
    if (!token) throw new Error("Diff context exceeded the baseline.");
    lines.push(displayLine("context", token, baseCursor + 1, newCursor + 1));
    baseCursor += 1;
    newCursor += 1;
  }

  const frozenEdits = Object.freeze([...group]);
  const frozenLines = Object.freeze(lines);
  return Object.freeze({
    kind: "text",
    id: digest({ path, kind: "text", edits: frozenEdits }),
    oldStart: windowStart,
    oldLines: windowEnd - windowStart,
    newStart: newPositionBefore(windowStart, allEdits),
    newLines: lines.filter((line) => line.kind !== "deletion").length,
    edits: frozenEdits,
    lines: frozenLines,
  });
}

function createBomHunk(path: string, baseline: TextContentMetadata, edited: TextContentMetadata): BomChangeHunk {
  return Object.freeze({
    kind: "bom",
    id: digest({ path, kind: "bom", baseline: baseline.bom, edited: edited.bom }),
    baseline: baseline.bom,
    edited: edited.bom,
  });
}

function validLimits(limits: TextDiffLimits): boolean {
  return Number.isSafeInteger(limits.maxEditLength)
    && limits.maxEditLength >= 0
    && Number.isSafeInteger(limits.timeoutMs)
    && limits.timeoutMs >= 0
    && Number.isSafeInteger(limits.contextLines)
    && limits.contextLines >= 0;
}

export function diffTextFiles(
  path: string,
  baseline: DecodedTextFile,
  edited: DecodedTextFile,
  limits: TextDiffLimits = DEFAULT_TEXT_DIFF_LIMITS,
): TextFileDiffResult {
  if (!path) throw new TypeError("A manifest-relative path is required for a text diff.");
  if (!validLimits(limits)) throw new TypeError("Text diff limits must be non-negative safe integers.");

  const edits = computeEdits(baseline.lines, edited.lines, limits);
  if (!edits) return { ok: false, reason: "diff-too-complex" };

  const hunks: ChangeHunk[] = [];
  if (baseline.metadata.bom !== edited.metadata.bom) {
    hunks.push(createBomHunk(path, baseline.metadata, edited.metadata));
  }
  for (const group of groupEdits(edits, limits.contextLines)) {
    hunks.push(createTextHunk(path, group, edits, baseline.lines, limits.contextLines));
  }

  return {
    ok: true,
    value: Object.freeze({
      path,
      baseline: baseline.metadata,
      edited: edited.metadata,
      edits,
      hunks: Object.freeze(hunks),
    }),
  };
}

export function diffTextEdits(
  baseline: readonly TextLineToken[],
  edited: readonly TextLineToken[],
  limits: TextDiffLimits = DEFAULT_TEXT_DIFF_LIMITS,
): readonly TextEdit[] | undefined {
  if (!validLimits(limits)) throw new TypeError("Text diff limits must be non-negative safe integers.");
  return computeEdits(baseline, edited, limits);
}
