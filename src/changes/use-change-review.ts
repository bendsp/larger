import { useEffect, useMemo, useState } from "react";
import type {
  ChangeFile,
  ChangeSelection,
  ChangeSetSnapshot,
  FileHunkSelection,
  TextFileChange,
} from "@/change-contracts";

export type ChangeFileFilter = "all" | "included" | "issues";

export interface ChangeSelectionSummary {
  readonly selectedFiles: number;
  readonly selectedHunks: number;
  readonly supportedFiles: number;
  readonly totalHunks: number;
  readonly unsupportedFiles: number;
}

export interface FileSelectionState {
  readonly included: boolean;
  readonly checked: boolean;
  readonly indeterminate: boolean;
  readonly selectedHunks: number;
  readonly totalHunks: number;
}

function selectedIds(selection: ChangeSelection, fileId: string): ReadonlySet<string> {
  return new Set(selection.files.find((file) => file.fileId === fileId)?.hunkIds ?? []);
}

interface SelectionEntry {
  readonly includeFile: boolean;
  readonly hunkIds: ReadonlySet<string>;
}

function orderedSelection(
  snapshot: ChangeSetSnapshot,
  selectedById: ReadonlyMap<string, SelectionEntry>,
): ChangeSelection {
  const files: FileHunkSelection[] = [];
  for (const file of snapshot.files) {
    if (file.kind !== "text") continue;
    const selected = selectedById.get(file.id);
    const hunkIds = file.hunks.map((hunk) => hunk.id).filter((id) => selected?.hunkIds.has(id));
    if (selected?.includeFile) files.push({ fileId: file.id, includeFile: true, hunkIds });
  }
  return { files };
}

function selectionMap(selection: ChangeSelection): Map<string, SelectionEntry> {
  return new Map(selection.files.map((file) => [file.fileId, {
    includeFile: file.includeFile,
    hunkIds: new Set(file.hunkIds),
  }]));
}

export function setFileIncluded(
  snapshot: ChangeSetSnapshot,
  filePath: string,
  included: boolean,
): ChangeSelection {
  const file = snapshot.files.find((candidate) => candidate.path === filePath);
  if (!file || file.kind !== "text") return snapshot.selection;
  const next = selectionMap(snapshot.selection);
  if (included) next.set(file.id, { includeFile: true, hunkIds: new Set(file.hunks.map((hunk) => hunk.id)) });
  else next.delete(file.id);
  return orderedSelection(snapshot, next);
}

export function setHunkIncluded(
  snapshot: ChangeSetSnapshot,
  filePath: string,
  hunkId: string,
  included: boolean,
): ChangeSelection {
  const file = snapshot.files.find((candidate) => candidate.path === filePath);
  if (!file || file.kind !== "text" || !file.hunks.some((hunk) => hunk.id === hunkId)) {
    return snapshot.selection;
  }
  const next = selectionMap(snapshot.selection);
  const ids = new Set(next.get(file.id)?.hunkIds ?? []);
  if (included) ids.add(hunkId);
  else ids.delete(hunkId);
  if (ids.size > 0) next.set(file.id, { includeFile: true, hunkIds: ids });
  else next.delete(file.id);
  return orderedSelection(snapshot, next);
}

export function fileSelectionState(
  file: ChangeFile,
  selection: ChangeSelection,
): FileSelectionState {
  if (file.kind !== "text") {
    return { included: false, checked: false, indeterminate: false, selectedHunks: 0, totalHunks: 0 };
  }
  const selectionEntry = selection.files.find((candidate) => candidate.fileId === file.id);
  const ids = selectedIds(selection, file.id);
  const selectedHunks = file.hunks.filter((hunk) => ids.has(hunk.id)).length;
  const included = selectionEntry?.includeFile === true;
  return {
    included,
    checked: included && (file.hunks.length === 0 || selectedHunks === file.hunks.length),
    indeterminate: included && selectedHunks > 0 && selectedHunks < file.hunks.length,
    selectedHunks,
    totalHunks: file.hunks.length,
  };
}

export function summarizeSelection(snapshot: ChangeSetSnapshot): ChangeSelectionSummary {
  let selectedFiles = 0;
  let selectedHunks = 0;
  let supportedFiles = 0;
  let totalHunks = 0;
  let unsupportedFiles = 0;
  for (const file of snapshot.files) {
    if (file.kind === "unsupported") {
      unsupportedFiles += 1;
      continue;
    }
    supportedFiles += 1;
    totalHunks += file.hunks.length;
    const state = fileSelectionState(file, snapshot.selection);
    if (state.included) selectedFiles += 1;
    selectedHunks += state.selectedHunks;
  }
  return { selectedFiles, selectedHunks, supportedFiles, totalHunks, unsupportedFiles };
}

function issuePaths(snapshot: ChangeSetSnapshot): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    if (file.kind === "unsupported") paths.add(file.path);
  }
  for (const result of snapshot.application?.files ?? []) {
    if (result.outcome === "conflicted" || result.outcome === "rollback-conflict") paths.add(result.path);
  }
  for (const path of snapshot.recovery?.conflictPaths ?? []) paths.add(path);
  return paths;
}

function filterFiles(
  snapshot: ChangeSetSnapshot,
  filter: ChangeFileFilter,
): readonly ChangeFile[] {
  if (filter === "all") return snapshot.files;
  if (filter === "included") {
    return snapshot.files.filter((file) => fileSelectionState(file, snapshot.selection).included);
  }
  const issues = issuePaths(snapshot);
  return snapshot.files.filter((file) => issues.has(file.path));
}

export function selectedHunkIds(
  file: TextFileChange,
  selection: ChangeSelection,
): ReadonlySet<string> {
  const valid = new Set(file.hunks.map((hunk) => hunk.id));
  return new Set([...selectedIds(selection, file.id)].filter((id) => valid.has(id)));
}

export function useChangeReview(snapshot: ChangeSetSnapshot) {
  const [filter, setFilter] = useState<ChangeFileFilter>("all");
  const [selectedPath, setSelectedPath] = useState<string | null>(snapshot.files[0]?.path ?? null);
  const files = useMemo(() => filterFiles(snapshot, filter), [filter, snapshot]);
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;

  useEffect(() => {
    if (selectedFile?.path !== selectedPath) setSelectedPath(selectedFile?.path ?? null);
  }, [selectedFile?.path, selectedPath]);

  useEffect(() => {
    setFilter("all");
    setSelectedPath(snapshot.files[0]?.path ?? null);
  }, [snapshot.id]);

  return {
    filter,
    setFilter,
    files,
    selectedFile,
    selectedPath: selectedFile?.path ?? null,
    setSelectedPath,
    summary: useMemo(() => summarizeSelection(snapshot), [snapshot]),
    issuePaths: useMemo(() => issuePaths(snapshot), [snapshot]),
  };
}
