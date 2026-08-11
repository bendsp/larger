import { useRef, useState } from "react";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  FileCheck2Icon,
  FileClockIcon,
  FileDiffIcon,
  FilePenLineIcon,
  FilePlus2Icon,
  FileQuestionIcon,
  FileX2Icon,
  FolderSyncIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ScanSearchIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from "lucide-react";
import type {
  ChangeFile,
  ChangeRecoveryMetadata,
  ChangeSelection,
  ChangeSetSnapshot,
  FileApplicationOutcome,
  RecoveryAction,
} from "@/change-contracts";
import type { PreparedApplyResult } from "@/change-ipc";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { ChangesDiff, operationLabels, unsupportedMessages } from "@/studio/changes-diff";
import {
  fileSelectionState,
  selectedHunkIds,
  setFileIncluded,
  setHunkIncluded,
  type ChangeFileFilter,
  type ChangeSelectionSummary,
  useChangeReview,
} from "./use-change-review";

export type ChangeWorkspaceOperation = "idle" | "scanning" | "preparing-apply" | "applying" | "discarding" | "recovering";
type ActionResult = void | Promise<void>;

export interface ChangeWorkspaceProps {
  readonly changeSet: ChangeSetSnapshot | null;
  readonly workspacePrepared: boolean;
  readonly trusted: boolean;
  readonly operation?: ChangeWorkspaceOperation;
  readonly busy?: boolean;
  readonly hydrated?: boolean;
  readonly problem?: string | null;
  readonly onPrepareWorkspace?: () => ActionResult;
  readonly onScan?: () => ActionResult;
  readonly onSelectionChange?: (selection: ChangeSelection) => ActionResult;
  readonly onPrepareApply?: (changeSet: ChangeSetSnapshot) => Promise<PreparedApplyResult | null>;
  readonly onCommitApply?: (prepared: PreparedApplyResult) => ActionResult;
  readonly onCancelPrepared?: (prepared: PreparedApplyResult) => ActionResult;
  readonly onDiscard?: (changeSet: ChangeSetSnapshot) => ActionResult;
  readonly onRecover?: (changeSet: ChangeSetSnapshot, action: RecoveryAction) => ActionResult;
}

const operationIcons = {
  add: FilePlus2Icon,
  modify: FilePenLineIcon,
  delete: FileX2Icon,
} as const;

const statusLabels = {
  detected: "Detected",
  reviewing: "Reviewing",
  applying: "Applying",
  applied: "Applied",
  conflicted: "Conflicted",
  discarded: "Discarded",
  failed: "Failed",
} as const;

const outcomeLabels: Record<FileApplicationOutcome, string> = {
  pending: "Pending",
  "not-selected": "Unapplied",
  applied: "Applied",
  "already-satisfied": "Already present",
  conflicted: "Conflict",
  unsupported: "Unsupported",
  "rolled-back": "Rolled back",
  "rollback-conflict": "Rollback conflict",
};

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

function WorkspaceUnavailable({
  trusted,
  busy,
  onPrepareWorkspace,
}: {
  trusted: boolean;
  busy: boolean;
  onPrepareWorkspace?: () => ActionResult;
}) {
  return (
    <Empty className="h-full rounded-none border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon"><FolderSyncIcon /></EmptyMedia>
        <EmptyTitle>Prepare a runtime workspace</EmptyTitle>
        <EmptyDescription>
          Changes are detected between an immutable baseline and the disposable runtime. Your source checkout remains authoritative.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {!trusted && <p className="text-xs text-muted-foreground">Trust this project before preparing its runtime workspace.</p>}
        <Button disabled={!trusted || busy || !onPrepareWorkspace} onClick={() => void onPrepareWorkspace?.()}>
          {busy ? <Spinner data-icon="inline-start" /> : <FolderSyncIcon data-icon="inline-start" />}
          Prepare workspace
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function ScanningState() {
  return (
    <Empty className="h-full rounded-none border-0" aria-busy="true">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Spinner /></EmptyMedia>
        <EmptyTitle>Scanning runtime changes</EmptyTitle>
        <EmptyDescription>Larger is comparing the runtime with its immutable baseline and persisting review data.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent><p role="status" aria-live="polite" className="text-xs text-muted-foreground">Scanning files…</p></EmptyContent>
    </Empty>
  );
}

function RestoringState() {
  return (
    <Empty className="h-full rounded-none border-0" aria-busy="true">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Spinner /></EmptyMedia>
        <EmptyTitle>Restoring change review</EmptyTitle>
        <EmptyDescription>Larger is loading durable review and recovery state for this project.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent><p role="status" aria-live="polite" className="text-xs text-muted-foreground">Loading review state…</p></EmptyContent>
    </Empty>
  );
}

function CleanState({ busy, onScan }: { busy: boolean; onScan?: () => ActionResult }) {
  return (
    <Empty className="h-full rounded-none border-0" aria-busy={busy}>
      <EmptyHeader>
        <EmptyMedia variant="icon"><FileCheck2Icon /></EmptyMedia>
        <EmptyTitle>No runtime changes</EmptyTitle>
        <EmptyDescription>The runtime matches its immutable baseline. Source files have not been touched.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" disabled={busy || !onScan} onClick={() => void onScan?.()}>
          {busy ? <Spinner data-icon="inline-start" /> : <ScanSearchIcon data-icon="inline-start" />}
          {busy ? "Scanning…" : "Scan again"}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function ScanFailureState({
  busy,
  message,
  onScan,
}: {
  busy: boolean;
  message: string;
  onScan?: () => ActionResult;
}) {
  return (
    <Empty className="h-full rounded-none border-0" aria-busy={busy}>
      <EmptyHeader>
        <EmptyMedia variant="icon"><AlertCircleIcon /></EmptyMedia>
        <EmptyTitle>Runtime scan failed</EmptyTitle>
        <EmptyDescription>Larger could not establish a stable runtime snapshot. No clean result was recorded.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-md">
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Changes were not reviewed</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
        <Button variant="outline" disabled={busy || !onScan} onClick={() => void onScan?.()}>
          {busy ? <Spinner data-icon="inline-start" /> : <ScanSearchIcon data-icon="inline-start" />}
          {busy ? "Scanning…" : "Try again"}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function CompletedState({
  snapshot,
  busy,
  onScan,
}: {
  snapshot: ChangeSetSnapshot;
  busy: boolean;
  onScan?: () => ActionResult;
}) {
  const applied = snapshot.status === "applied";
  return (
    <Empty className="h-full rounded-none border-0" aria-busy={busy}>
      <EmptyHeader>
        <EmptyMedia variant="icon">{applied ? <CheckCircle2Icon /> : <Trash2Icon />}</EmptyMedia>
        <EmptyTitle>{applied ? "Selected changes applied" : "Runtime changes discarded"}</EmptyTitle>
        <EmptyDescription>
          {applied
            ? "The selected result was written through the recoverable source transaction."
            : "The disposable runtime was reset and the review was closed. Its durable audit history remains in Larger app data."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" disabled={busy || !onScan} onClick={() => void onScan?.()}>
          {busy ? <Spinner data-icon="inline-start" /> : <ScanSearchIcon data-icon="inline-start" />}
          {busy ? "Scanning…" : "Scan runtime"}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function FilterItem({ value, count }: { value: ChangeFileFilter; count: number }) {
  const label = value === "all" ? "All" : value === "included" ? "Included" : "Issues";
  return (
    <ToggleGroupItem value={value} aria-label={`Show ${label.toLowerCase()} files`}>
      {label}<Badge variant="outline" className="ml-1 h-4 px-1 text-[10px]">{count}</Badge>
    </ToggleGroupItem>
  );
}

function FileRow({
  file,
  snapshot,
  selected,
  disabled,
  issue,
  onSelect,
  onSelectionChange,
}: {
  file: ChangeFile;
  snapshot: ChangeSetSnapshot;
  selected: boolean;
  disabled: boolean;
  issue: boolean;
  onSelect(): void;
  onSelectionChange(selection: ChangeSelection): void;
}) {
  const state = fileSelectionState(file, snapshot.selection);
  const Icon = operationIcons[file.operation];
  const outcome = snapshot.application?.files.find((result) => result.path === file.path)?.outcome;
  return (
    <li className={cn("flex items-start gap-2 border-b px-2 py-1.5 last:border-b-0", selected && "bg-muted/70")}>
      <Checkbox
        className="mt-2.5"
        checked={state.checked}
        indeterminate={state.indeterminate}
        disabled={disabled || file.kind === "unsupported"}
        aria-label={`${state.checked ? "Exclude" : "Include"} all supported hunks in ${file.path}`}
        onCheckedChange={(included) => onSelectionChange(setFileIncluded(snapshot, file.path, included))}
      />
      <Button
        variant="ghost"
        className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-2 text-left"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs">{file.path}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>{operationLabels[file.operation]}</span>
            {file.kind === "text" && <span>{plural(file.hunks.length, "hunk")}</span>}
            {file.kind === "unsupported" && <span>{unsupportedMessages[file.reason]}</span>}
          </span>
        </span>
        {(issue || outcome) && (
          <Badge variant={issue ? "destructive" : "outline"} className="shrink-0">
            {issue ? "Issue" : outcomeLabels[outcome!]}
          </Badge>
        )}
      </Button>
    </li>
  );
}

function FileList({
  snapshot,
  files,
  selectedPath,
  filter,
  issuePaths,
  disabled,
  onFilterChange,
  onSelect,
  onSelectionChange,
}: {
  snapshot: ChangeSetSnapshot;
  files: readonly ChangeFile[];
  selectedPath: string | null;
  filter: ChangeFileFilter;
  issuePaths: ReadonlySet<string>;
  disabled: boolean;
  onFilterChange(filter: ChangeFileFilter): void;
  onSelect(path: string): void;
  onSelectionChange(selection: ChangeSelection): void;
}) {
  const includedCount = snapshot.files.filter((file) => fileSelectionState(file, snapshot.selection).included).length;
  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="changed-files-heading">
      <header className="shrink-0 border-b p-3">
        <h2 id="changed-files-heading" className="text-sm font-medium">Changed files</h2>
        <ToggleGroup
          className="mt-2 flex-wrap"
          aria-label="Filter changed files"
          value={[filter]}
          variant="outline"
          size="sm"
          spacing={0}
          onValueChange={(values) => {
            const next = values[0] as ChangeFileFilter | undefined;
            if (next) onFilterChange(next);
          }}
        >
          <FilterItem value="all" count={snapshot.files.length} />
          <FilterItem value="included" count={includedCount} />
          <FilterItem value="issues" count={issuePaths.size} />
        </ToggleGroup>
      </header>
      <ScrollArea className="min-h-0 flex-1" aria-label="Changed files">
        {files.length > 0 ? (
          <ul>
            {files.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                snapshot={snapshot}
                selected={file.path === selectedPath}
                disabled={disabled}
                issue={issuePaths.has(file.path)}
                onSelect={() => onSelect(file.path)}
                onSelectionChange={onSelectionChange}
              />
            ))}
          </ul>
        ) : (
          <Empty className="h-full rounded-none border-0 py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon"><FileQuestionIcon /></EmptyMedia>
              <EmptyTitle>No matching files</EmptyTitle>
              <EmptyDescription>Choose another filter to continue reviewing.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </ScrollArea>
    </section>
  );
}

function RecoveryCard({
  snapshot,
  recovery,
  disabled,
  onRecover,
}: {
  snapshot: ChangeSetSnapshot;
  recovery: ChangeRecoveryMetadata;
  disabled: boolean;
  onRecover?: (changeSet: ChangeSetSnapshot, action: RecoveryAction) => ActionResult;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm"><FileClockIcon className="size-4" />Source transaction</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-xs text-muted-foreground">
        <p>{plural(recovery.appliedCount, "file")} replaced · {plural(recovery.pendingCount, "file")} pending</p>
        {recovery.conflictPaths.length > 0 && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>Recovery conflict</AlertTitle>
            <AlertDescription>{plural(recovery.conflictPaths.length, "source file")} changed after the interruption.</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-2">
          {recovery.availableActions.includes("roll-forward") && (
            <Button size="sm" disabled={disabled || !onRecover} onClick={() => void onRecover?.(snapshot, "roll-forward")}>
              <RefreshCwIcon data-icon="inline-start" />Roll forward safely
            </Button>
          )}
          {recovery.availableActions.includes("roll-back") && (
            <Button size="sm" variant="outline" disabled={disabled || !onRecover} onClick={() => void onRecover?.(snapshot, "roll-back")}>
              <RotateCcwIcon data-icon="inline-start" />Roll back safely
            </Button>
          )}
          {recovery.availableActions.length === 0 && (
            <p>No automatic recovery action is safe. Resolve the listed source files before scanning again.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ReviewSummary({
  snapshot,
  summary,
  disabled,
  operation,
  onPrepareApply,
  onCommitApply,
  onCancelPrepared,
  onDiscard,
  onRecover,
}: {
  snapshot: ChangeSetSnapshot;
  summary: ChangeSelectionSummary;
  disabled: boolean;
  operation: ChangeWorkspaceOperation;
  onPrepareApply?: (changeSet: ChangeSetSnapshot) => Promise<PreparedApplyResult | null>;
  onCommitApply?: (prepared: PreparedApplyResult) => ActionResult;
  onCancelPrepared?: (prepared: PreparedApplyResult) => ActionResult;
  onDiscard?: (changeSet: ChangeSetSnapshot) => ActionResult;
  onRecover?: (changeSet: ChangeSetSnapshot, action: RecoveryAction) => ActionResult;
}) {
  const [applyOpen, setApplyOpen] = useState(false);
  const [prepared, setPrepared] = useState<PreparedApplyResult | null>(null);
  const committingPrepared = useRef(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const recoveryRequired = snapshot.recovery?.actionRequired === true;
  const conflict = snapshot.status === "conflicted";
  const reviewable = snapshot.status === "detected" || snapshot.status === "reviewing";
  const preparedOnly = recoveryRequired
    && (snapshot.recovery?.appliedCount ?? 0) === 0
    && (snapshot.recovery?.conflictPaths.length ?? 0) === 0;
  const visibleStatus = preparedOnly ? "Prepared" : recoveryRequired ? "Recovery needed" : statusLabels[snapshot.status];
  const sourceSummary = preparedOnly
    ? "Source is unchanged. Apply or roll back the prepared selection."
    : recoveryRequired
      ? "Application stopped before every selected file completed."
      : "Source remains unchanged until Apply.";
  const canApply = summary.selectedFiles > 0 && !disabled && !recoveryRequired && !conflict && reviewable && Boolean(onPrepareApply && onCommitApply);
  const applyCount = summary.selectedHunks > 0
    ? plural(summary.selectedHunks, "hunk")
    : plural(summary.selectedFiles, "file");
  const changeApplyOpen = (open: boolean) => {
    setApplyOpen(open);
    if (!open && prepared && !committingPrepared.current) {
      const abandoned = prepared;
      setPrepared(null);
      void onCancelPrepared?.(abandoned);
    }
    committingPrepared.current = false;
  };
  return (
    <aside className="flex h-full min-h-0 flex-col" aria-labelledby="review-summary-heading">
      <ScrollArea className="min-h-0 flex-1" aria-label="Change review summary">
        <div className="flex flex-col gap-4 p-4">
          <div>
            <div className="flex items-center justify-between gap-2">
              <h2 id="review-summary-heading" className="text-sm font-medium">Review summary</h2>
              <Badge variant={conflict || snapshot.status === "failed" ? "destructive" : "secondary"}>
                {visibleStatus}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{sourceSummary}</p>
          </div>
          <Card>
            <CardHeader><CardTitle className="text-sm">Selection</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 p-4">
              <div><div className="text-xl font-semibold tabular-nums">{summary.selectedFiles}</div><div className="text-xs text-muted-foreground">Included files</div></div>
              <div><div className="text-xl font-semibold tabular-nums">{summary.selectedHunks}</div><div className="text-xs text-muted-foreground">Included hunks</div></div>
              <div><div className="text-xl font-semibold tabular-nums">{summary.totalHunks - summary.selectedHunks}</div><div className="text-xs text-muted-foreground">Left unapplied</div></div>
              <div><div className="text-xl font-semibold tabular-nums">{summary.unsupportedFiles}</div><div className="text-xs text-muted-foreground">Unsupported</div></div>
            </CardContent>
          </Card>
          {snapshot.recovery?.actionRequired && (
            <RecoveryCard snapshot={snapshot} recovery={snapshot.recovery} disabled={disabled} onRecover={onRecover} />
          )}
          {snapshot.application && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Last application</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-2">
                {snapshot.application.files.map((file) => (
                  <div key={file.path} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate font-mono" title={file.path}>{file.path}</span>
                    <Badge variant={file.outcome.includes("conflict") ? "destructive" : "outline"}>{outcomeLabels[file.outcome]}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </ScrollArea>
      <footer className="flex shrink-0 flex-col gap-2 border-t p-4">
        <Button
          className="w-full"
          disabled={!canApply}
          onClick={() => {
            void onPrepareApply?.(snapshot).then((result) => {
              if (!result || result.status !== "prepared" || !result.transactionId || !result.planDigest) return;
              setPrepared(result);
              setApplyOpen(true);
            });
          }}
        >
            {operation === "preparing-apply" || operation === "applying" ? <Spinner data-icon="inline-start" /> : <FileDiffIcon data-icon="inline-start" />}
            Apply {applyCount}
        </Button>
        <AlertDialog open={applyOpen} onOpenChange={changeApplyOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia><FileDiffIcon /></AlertDialogMedia>
              <AlertDialogTitle>Apply selected changes to source?</AlertDialogTitle>
              <AlertDialogDescription>
                Larger prepared {plural(prepared?.selectedHunkCount ?? summary.selectedHunks, "hunk")} across {plural(prepared?.selectedFileCount ?? summary.selectedFiles, "file")}. Apply will write only this reviewed selection. If source changes first, Larger will stop and ask you to review again.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => {
                if (!prepared) return;
                committingPrepared.current = true;
                const committed = prepared;
                setPrepared(null);
                void onCommitApply?.(committed);
              }}>Apply to source</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
          <AlertDialogTrigger
            disabled={disabled || !onDiscard}
            render={<Button className="w-full" variant="ghost" disabled={disabled || !onDiscard} />}
          >
            <Trash2Icon data-icon="inline-start" />Discard unapplied changes
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia><ShieldAlertIcon /></AlertDialogMedia>
              <AlertDialogTitle>Discard unapplied runtime changes?</AlertDialogTitle>
              <AlertDialogDescription>
                This resets the disposable runtime and closes {plural(snapshot.files.length, "runtime file change")}. Source files are not changed. Larger retains durable audit history in app data.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel autoFocus>Keep reviewing</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => { setDiscardOpen(false); void onDiscard?.(snapshot); }}>Discard changes</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </footer>
    </aside>
  );
}

function ReviewWorkspace({
  snapshot,
  operation,
  busy: clientBusy,
  problem,
  onScan,
  onSelectionChange,
  onPrepareApply,
  onCommitApply,
  onCancelPrepared,
  onDiscard,
  onRecover,
}: {
  snapshot: ChangeSetSnapshot;
  operation: ChangeWorkspaceOperation;
  busy: boolean;
  problem: string | null;
  onScan?: () => ActionResult;
  onSelectionChange?: (selection: ChangeSelection) => ActionResult;
  onPrepareApply?: (changeSet: ChangeSetSnapshot) => Promise<PreparedApplyResult | null>;
  onCommitApply?: (prepared: PreparedApplyResult) => ActionResult;
  onCancelPrepared?: (prepared: PreparedApplyResult) => ActionResult;
  onDiscard?: (changeSet: ChangeSetSnapshot) => ActionResult;
  onRecover?: (changeSet: ChangeSetSnapshot, action: RecoveryAction) => ActionResult;
}) {
  const review = useChangeReview(snapshot);
  const busy = clientBusy || (snapshot.status === "applying" && !snapshot.recovery?.actionRequired);
  const unsupported = snapshot.files.filter((file) => file.kind === "unsupported");
  const conflicted = snapshot.status === "conflicted"
    || (snapshot.application?.files.some((file) => file.outcome === "conflicted" || file.outcome === "rollback-conflict") ?? false)
    || (snapshot.recovery?.conflictPaths.length ?? 0) > 0;
  const selectionDisabled = busy || !onSelectionChange;
  const selectedIds = review.selectedFile?.kind === "text"
    ? selectedHunkIds(review.selectedFile, snapshot.selection)
    : new Set<string>();
  const updateSelection = (selection: ChangeSelection) => void onSelectionChange?.(selection);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex min-h-12 shrink-0 items-center gap-3 border-b px-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">Runtime change review</h2>
            <Badge variant="outline">{plural(snapshot.files.length, "file")}</Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">Exact filesystem diff from runtime to immutable baseline</p>
        </div>
        {busy && <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" />{operation === "idle" ? "applying" : operation}</div>}
        <Button size="sm" variant="outline" disabled={busy || !onScan} onClick={() => void onScan?.()}>
          <RefreshCwIcon data-icon="inline-start" />Scan
        </Button>
      </header>
      {(problem || conflicted || unsupported.length > 0 || snapshot.recovery?.actionRequired) && (
        <div className="grid shrink-0 gap-2 border-b bg-muted/20 px-4 py-3 lg:grid-cols-2">
          {problem && <Alert variant="destructive"><AlertCircleIcon /><AlertTitle>Change operation failed</AlertTitle><AlertDescription>{problem}</AlertDescription></Alert>}
          {conflicted && <Alert variant="destructive"><AlertTriangleIcon /><AlertTitle>Source conflict</AlertTitle><AlertDescription>Source changed in overlapping lines. Larger did not overwrite those files.</AlertDescription></Alert>}
          {unsupported.length > 0 && <Alert><ShieldAlertIcon /><AlertTitle>{plural(unsupported.length, "unsupported change")}</AlertTitle><AlertDescription>Unsupported files stay visible and cannot be silently selected or applied.</AlertDescription></Alert>}
          {snapshot.recovery?.actionRequired && <Alert><FileClockIcon /><AlertTitle>Source transaction needs attention</AlertTitle><AlertDescription>Review the transaction summary before continuing source work.</AlertDescription></Alert>}
        </div>
      )}
      <div className="min-h-0 flex-1" aria-busy={busy}>
        <ResizablePanelGroup id="changes-review-layout" orientation="horizontal">
          <ResizablePanel id="changes-files" defaultSize="24%" minSize={220} maxSize={380}>
            <FileList
              snapshot={snapshot}
              files={review.files}
              selectedPath={review.selectedPath}
              filter={review.filter}
              issuePaths={review.issuePaths}
              disabled={selectionDisabled}
              onFilterChange={review.setFilter}
              onSelect={review.setSelectedPath}
              onSelectionChange={updateSelection}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="changes-diff" defaultSize="52%" minSize={380}>
            <ChangesDiff
              file={review.selectedFile}
              selectedHunkIds={selectedIds}
              disabled={selectionDisabled}
              onToggleHunk={(hunkId, included) => {
                if (!review.selectedFile) return;
                updateSelection(setHunkIncluded(snapshot, review.selectedFile.path, hunkId, included));
              }}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="changes-summary" defaultSize="24%" minSize={260} maxSize={380}>
            <ReviewSummary
              snapshot={snapshot}
              summary={review.summary}
              disabled={busy}
              operation={operation}
              onPrepareApply={onPrepareApply}
              onCommitApply={onCommitApply}
              onCancelPrepared={onCancelPrepared}
              onDiscard={onDiscard}
              onRecover={onRecover}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

export function ChangeWorkspace({
  changeSet,
  workspacePrepared,
  trusted,
  operation = "idle",
  busy: clientBusy = false,
  hydrated = true,
  problem = null,
  onPrepareWorkspace,
  onScan,
  onSelectionChange,
  onPrepareApply,
  onCommitApply,
  onCancelPrepared,
  onDiscard,
  onRecover,
}: ChangeWorkspaceProps) {
  const busy = clientBusy || operation !== "idle";
  if (!hydrated) return <RestoringState />;
  if (!workspacePrepared) {
    return <WorkspaceUnavailable trusted={trusted} busy={busy} onPrepareWorkspace={onPrepareWorkspace} />;
  }
  if (operation === "scanning" && !changeSet) return <ScanningState />;
  if (problem && (!changeSet || (changeSet.files.length === 0 && !changeSet.recovery?.actionRequired))) {
    return <ScanFailureState busy={busy} message={problem} onScan={onScan} />;
  }
  if (!changeSet) return <CleanState busy={busy} onScan={onScan} />;
  if (changeSet.status === "applied" || changeSet.status === "discarded") {
    return <CompletedState snapshot={changeSet} busy={busy} onScan={onScan} />;
  }
  if (changeSet.files.length === 0 && !changeSet.recovery?.actionRequired) {
    return <CleanState busy={busy} onScan={onScan} />;
  }
  return (
    <ReviewWorkspace
      snapshot={changeSet}
      operation={operation}
      busy={busy}
      problem={problem}
      onScan={onScan}
      onSelectionChange={onSelectionChange}
      onPrepareApply={onPrepareApply}
      onCommitApply={onCommitApply}
      onCancelPrepared={onCancelPrepared}
      onDiscard={onDiscard}
      onRecover={onRecover}
    />
  );
}
