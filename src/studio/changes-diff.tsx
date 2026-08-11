import {
  AlertTriangleIcon,
  FileDiffIcon,
  FileQuestionIcon,
  GitCompareArrowsIcon,
} from "lucide-react";
import type {
  BomChangeHunk,
  ChangeFile,
  DiffDisplayLine,
  TextChangeHunk,
  TextFileChange,
  UnsupportedChangeReason,
} from "@/change-contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const unsupportedMessages: Record<UnsupportedChangeReason, string> = {
  binary: "This file contains binary content.",
  "unsupported-encoding": "This file is not valid UTF-8 text.",
  "file-too-large": "This file exceeds the safe review size.",
  "too-many-lines": "This file has too many lines for a safe text diff.",
  "line-too-long": "This file contains a line that is too long to review safely.",
  "diff-too-complex": "A reliable text diff could not be produced within safe limits.",
  symlink: "Symbolic-link changes are not supported in this sprint.",
  "special-file": "This filesystem entry is not a regular text file.",
  "mode-change": "File-mode changes are visible but cannot be applied yet.",
  "unstable-read": "The file changed while Larger was reading it. Scan again when writes settle.",
};

const operationLabels = {
  add: "Added",
  modify: "Modified",
  delete: "Deleted",
} as const;

function hunkLabel(hunk: TextChangeHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

function lineAccessibleText(line: DiffDisplayLine): string {
  const location = line.kind === "addition"
    ? `new line ${line.newLineNumber ?? "unknown"}`
    : line.kind === "deletion"
      ? `old line ${line.oldLineNumber ?? "unknown"}`
      : `old line ${line.oldLineNumber ?? "unknown"}, new line ${line.newLineNumber ?? "unknown"}`;
  const ending = line.terminator === "none" ? ", no line ending" : "";
  return `${line.kind}, ${location}${ending}: ${line.content}`;
}

function DiffLine({ line }: { line: DiffDisplayLine }) {
  const marker = line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " ";
  return (
    <div
      role="listitem"
      className={cn(
        "grid min-w-max grid-cols-[3rem_3rem_1.5rem_minmax(24rem,1fr)] border-b border-border/50 font-mono text-xs/5 last:border-b-0",
        line.kind === "addition" && "bg-primary/7",
        line.kind === "deletion" && "bg-destructive/7",
      )}
    >
      <span className="sr-only">{lineAccessibleText(line)}</span>
      <span aria-hidden="true" className="select-none border-r px-2 text-right text-muted-foreground/70">
        {line.oldLineNumber ?? ""}
      </span>
      <span aria-hidden="true" className="select-none border-r px-2 text-right text-muted-foreground/70">
        {line.newLineNumber ?? ""}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "select-none px-2 text-center text-muted-foreground",
          line.kind === "addition" && "text-primary",
          line.kind === "deletion" && "text-destructive",
        )}
      >
        {marker}
      </span>
      <code aria-hidden="true" className="whitespace-pre pr-4 text-foreground">
        {line.content || " "}
        {line.terminator === "none" && <span className="ml-3 text-muted-foreground">No newline at end of file</span>}
      </code>
    </div>
  );
}

function BomHunk({
  hunk,
  included,
  disabled,
  onIncludedChange,
}: {
  hunk: BomChangeHunk;
  included: boolean;
  disabled: boolean;
  onIncludedChange(included: boolean): void;
}) {
  const description = hunk.edited === "utf-8"
    ? "Add the UTF-8 byte order mark."
    : "Remove the UTF-8 byte order mark.";
  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3">
        <Checkbox
          checked={included}
          disabled={disabled}
          aria-label={`${included ? "Exclude" : "Include"} byte order mark change`}
          onCheckedChange={onIncludedChange}
        />
        <div className="min-w-0 flex-1">
          <CardTitle className="text-sm">Byte order mark</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <Badge variant="outline">BOM</Badge>
      </CardHeader>
    </Card>
  );
}

function TextHunk({
  hunk,
  included,
  disabled,
  onIncludedChange,
}: {
  hunk: TextChangeHunk;
  included: boolean;
  disabled: boolean;
  onIncludedChange(included: boolean): void;
}) {
  const label = hunkLabel(hunk);
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-center gap-3 border-b py-3">
        <Checkbox
          checked={included}
          disabled={disabled}
          aria-label={`${included ? "Exclude" : "Include"} hunk ${label}`}
          onCheckedChange={onIncludedChange}
        />
        <CardTitle className="min-w-0 flex-1 truncate font-mono text-xs font-normal">{label}</CardTitle>
        <Badge variant={included ? "secondary" : "outline"}>{included ? "Included" : "Unapplied"}</Badge>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <div role="list" aria-label={`Diff lines for ${label}`}>
          {hunk.lines.map((line, index) => <DiffLine key={`${line.kind}-${line.oldLineNumber}-${line.newLineNumber}-${index}`} line={line} />)}
        </div>
      </CardContent>
    </Card>
  );
}

function RenameHint({ file }: { file: ChangeFile }) {
  if (!file.possibleRename) return null;
  return (
    <Alert>
      <GitCompareArrowsIcon />
      <AlertTitle>Possible rename</AlertTitle>
      <AlertDescription>
        This content exactly matches <span className="font-mono text-xs">{file.possibleRename.otherPath}</span>. Larger still treats both paths as an add and a delete.
      </AlertDescription>
    </Alert>
  );
}

function UnsupportedDiff({ file }: { file: Extract<ChangeFile, { kind: "unsupported" }> }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-5 py-4">
        <div className="flex items-center gap-2">
          <Badge variant="outline">{operationLabels[file.operation]}</Badge>
          <Badge variant="destructive">Unsupported</Badge>
        </div>
        <h2 className="mt-2 break-all font-mono text-sm font-medium">{file.path}</h2>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Alert variant="destructive" className="max-w-xl">
          <AlertTriangleIcon />
          <AlertTitle>This change cannot be applied safely</AlertTitle>
          <AlertDescription>{unsupportedMessages[file.reason]}</AlertDescription>
        </Alert>
      </div>
    </div>
  );
}

function TextDiff({
  file,
  selectedHunkIds,
  disabled,
  onToggleHunk,
}: {
  file: TextFileChange;
  selectedHunkIds: ReadonlySet<string>;
  disabled: boolean;
  onToggleHunk(hunkId: string, included: boolean): void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-5 py-4">
        <div className="flex items-center gap-2">
          <Badge variant="outline">{operationLabels[file.operation]}</Badge>
          <span className="text-xs text-muted-foreground">
            {selectedHunkIds.size} of {file.hunks.length} hunks included
          </span>
        </div>
        <h2 className="mt-2 break-all font-mono text-sm font-medium">{file.path}</h2>
        {file.edited && (
          <p className="mt-1 text-xs text-muted-foreground">
            UTF-8{file.edited.bom === "utf-8" ? " with BOM" : ""} · {file.edited.lineEndings.toUpperCase()} · {file.edited.lineCount.toLocaleString()} lines
          </p>
        )}
      </header>
      <ScrollArea className="min-h-0 flex-1" aria-label={`Diff for ${file.path}`}>
        <div className="flex flex-col gap-4 p-5">
          <RenameHint file={file} />
          {file.hunks.map((hunk) => hunk.kind === "bom" ? (
            <BomHunk
              key={hunk.id}
              hunk={hunk}
              included={selectedHunkIds.has(hunk.id)}
              disabled={disabled}
              onIncludedChange={(included) => onToggleHunk(hunk.id, included)}
            />
          ) : (
            <TextHunk
              key={hunk.id}
              hunk={hunk}
              included={selectedHunkIds.has(hunk.id)}
              disabled={disabled}
              onIncludedChange={(included) => onToggleHunk(hunk.id, included)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

export function ChangesDiff({
  file,
  selectedHunkIds,
  disabled = false,
  onToggleHunk,
}: {
  file: ChangeFile | null;
  selectedHunkIds: ReadonlySet<string>;
  disabled?: boolean;
  onToggleHunk(hunkId: string, included: boolean): void;
}) {
  if (!file) {
    return (
      <Empty className="h-full rounded-none border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon"><FileQuestionIcon /></EmptyMedia>
          <EmptyTitle>Choose a changed file</EmptyTitle>
          <EmptyDescription>Select a file to inspect its exact runtime diff.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (file.kind === "unsupported") return <UnsupportedDiff file={file} />;
  return <TextDiff file={file} selectedHunkIds={selectedHunkIds} disabled={disabled} onToggleHunk={onToggleHunk} />;
}

export function ChangesDiffPlaceholder() {
  return (
    <Empty className="h-full rounded-none border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon"><FileDiffIcon /></EmptyMedia>
        <EmptyTitle>No diff selected</EmptyTitle>
        <EmptyDescription>Runtime text changes will appear here as exact hunks.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export { operationLabels, unsupportedMessages };
