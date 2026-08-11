import assert from "node:assert/strict";
import test from "node:test";
import type { ChangeSetSnapshot, TextChangeHunk, TextFileChange } from "../../src/change-contracts";
import {
  fileSelectionState,
  setFileIncluded,
  setHunkIncluded,
  summarizeSelection,
} from "../../src/changes/use-change-review";

function hunk(id: string): TextChangeHunk {
  return {
    kind: "text",
    id,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    edits: [],
    lines: [],
  };
}

const modified: TextFileChange = {
  kind: "text",
  id: "file-modified",
  path: "src/App.tsx",
  operation: "modify",
  baseline: null,
  edited: null,
  hunks: [hunk("hunk-one"), hunk("hunk-two")],
  possibleRename: null,
};

const emptyAddition: TextFileChange = {
  kind: "text",
  id: "file-empty",
  path: "src/empty.ts",
  operation: "add",
  baseline: null,
  edited: null,
  hunks: [],
  possibleRename: null,
};

function snapshot(selection: ChangeSetSnapshot["selection"] = { files: [] }): ChangeSetSnapshot {
  return {
    formatVersion: 1,
    id: "change-set",
    revision: 4,
    projectId: "project",
    instanceKey: "instance",
    baselineIdentity: "a".repeat(64),
    origin: { kind: "runtime-workspace", runtimeId: "runtime" },
    status: "reviewing",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    files: [modified, emptyAddition, {
      kind: "unsupported",
      id: "file-binary",
      path: "public/image.png",
      operation: "modify",
      reason: "binary",
      baseline: null,
      edited: null,
      possibleRename: null,
    }],
    selection,
    application: null,
    recovery: null,
  };
}

test("hunk selection uses opaque file ids and preserves explicit file intent", () => {
  const first = setHunkIncluded(snapshot(), modified.path, "hunk-one", true);
  assert.deepEqual(first, {
    files: [{ fileId: modified.id, includeFile: true, hunkIds: ["hunk-one"] }],
  });
  const second = setHunkIncluded(snapshot(first), modified.path, "hunk-two", true);
  assert.deepEqual(second.files[0], {
    fileId: modified.id,
    includeFile: true,
    hunkIds: ["hunk-one", "hunk-two"],
  });
  const state = fileSelectionState(modified, second);
  assert.equal(state.checked, true);
  assert.equal(state.indeterminate, false);
});

test("partial and removed hunk selections report the correct tri-state", () => {
  const partial = setHunkIncluded(snapshot(), modified.path, "hunk-one", true);
  assert.deepEqual(fileSelectionState(modified, partial), {
    included: true,
    checked: false,
    indeterminate: true,
    selectedHunks: 1,
    totalHunks: 2,
  });
  const removed = setHunkIncluded(snapshot(partial), modified.path, "hunk-one", false);
  assert.deepEqual(removed, { files: [] });
});

test("empty additions can be selected without inventing a hunk", () => {
  const selected = setFileIncluded(snapshot(), emptyAddition.path, true);
  assert.deepEqual(selected, {
    files: [{ fileId: emptyAddition.id, includeFile: true, hunkIds: [] }],
  });
  assert.deepEqual(fileSelectionState(emptyAddition, selected), {
    included: true,
    checked: true,
    indeterminate: false,
    selectedHunks: 0,
    totalHunks: 0,
  });
});

test("selection summaries keep unsupported files visible but unselected", () => {
  const allSupported = setFileIncluded(
    snapshot(setFileIncluded(snapshot(), modified.path, true)),
    emptyAddition.path,
    true,
  );
  assert.deepEqual(summarizeSelection(snapshot(allSupported)), {
    selectedFiles: 2,
    selectedHunks: 2,
    supportedFiles: 2,
    totalHunks: 2,
    unsupportedFiles: 1,
  });
});
