import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardIcon,
  EyeIcon,
  LinkIcon,
  MonitorPlayIcon,
  PlayIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  SquareIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import type {
  RuntimeLogEntry,
  RuntimePhase,
  RuntimeProblem,
  RuntimeProfileSummary,
} from "@/runtime-contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { RuntimeClient } from "./use-runtime";
import { loopbackHttpUrlProblem } from "@/runtime-network";

type RuntimeMode = "managed" | "attached";
type LogFilter = "all" | RuntimeLogEntry["source"];

const phaseDetails: Record<RuntimePhase, { label: string; progress: number }> = {
  idle: { label: "Idle", progress: 0 },
  recovering: { label: "Recovering previous session", progress: 8 },
  "preparing-workspace": { label: "Preparing workspace", progress: 16 },
  "preparing-dependencies": { label: "Preparing dependencies", progress: 30 },
  "allocating-port": { label: "Allocating port", progress: 42 },
  "starting-target": { label: "Starting development server", progress: 54 },
  "waiting-target": { label: "Waiting for readiness", progress: 68 },
  "starting-editor": { label: "Starting editor adapter", progress: 80 },
  "verifying-editor": { label: "Verifying editor security", progress: 92 },
  "validating-attach": { label: "Validating local server", progress: 60 },
  "ready-managed": { label: "Managed server ready", progress: 100 },
  "ready-attached": { label: "Preview attached", progress: 100 },
  stopping: { label: "Stopping managed processes", progress: 65 },
  cancelling: { label: "Cancelling operation", progress: 50 },
  cancelled: { label: "Cancelled", progress: 0 },
  failed: { label: "Needs attention", progress: 100 },
};

export function filterRuntimeLogs(entries: readonly RuntimeLogEntry[], filter: LogFilter): readonly RuntimeLogEntry[] {
  return filter === "all" ? entries : entries.filter((entry) => entry.source === filter);
}

export function formatRuntimeLogs(entries: readonly RuntimeLogEntry[]): string {
  return entries.map((entry) => (
    `${entry.timestamp} [${entry.source}/${entry.stream}] ${entry.message}`
  )).join("\n");
}

function validateAttachUrl(value: string): string | null {
  return loopbackHttpUrlProblem(value);
}

function RuntimeFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <Item size="xs" className="rounded-none px-0">
      <ItemContent><ItemDescription>{label}</ItemDescription></ItemContent>
      <ItemActions>
        <span className={mono ? "max-w-96 truncate font-mono text-xs" : "text-xs"} title={value}>{value}</span>
      </ItemActions>
    </Item>
  );
}

function ProfilePicker({
  profiles,
  selected,
  disabled,
  onSelect,
}: {
  profiles: readonly RuntimeProfileSummary[];
  selected: string;
  disabled: boolean;
  onSelect: (profileName: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" size="sm" variant="outline" disabled={disabled || profiles.length === 0} />}
      >
        {selected || "Choose profile"}
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Runtime profile</DropdownMenuLabel>
          {profiles.map((profile) => (
            <DropdownMenuItem key={profile.name} onClick={() => onSelect(profile.name)}>
              {profile.name === selected && <CheckIcon data-icon="inline-start" />}
              <span className="min-w-0 flex-1 truncate">{profile.name}</span>
              <span className="text-xs text-muted-foreground">:{profile.preferredPort}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RuntimeProblemAlert({
  problem,
  selectedProfile,
  runtime,
  onOpenSettings,
  onReviewAttach,
}: {
  problem: RuntimeProblem;
  selectedProfile: string;
  runtime: RuntimeClient;
  onOpenSettings: () => void;
  onReviewAttach: () => void;
}) {
  const actionLabel = (action: RuntimeProblem["actions"][number]) => {
    if (action === "retry" && problem.phase === "validating-attach") return "Review URL";
    return action.replaceAll("-", " ").replace(/^./, (character) => character.toUpperCase());
  };
  const act = (action: RuntimeProblem["actions"][number]) => {
    if (action === "retry") {
      if (problem.phase === "validating-attach") onReviewAttach();
      else if (runtime.session?.mode === "managed") void runtime.restart();
      else if (selectedProfile) void runtime.start(selectedProfile);
      return;
    }
    if (action === "stop") void runtime.stop();
    else if (action === "detach") void runtime.detach();
    else onOpenSettings();
  };
  return (
    <Alert variant="destructive">
      <AlertCircleIcon />
      <AlertTitle>Runtime needs attention</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <p>{problem.message}</p>
        {problem.actions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {problem.actions.map((action) => (
              <Button key={action} size="xs" variant="outline" disabled={runtime.busy} onClick={() => act(action)}>
                {actionLabel(action)}
              </Button>
            ))}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}

function ManagedRuntimeCard({
  runtime,
  trusted,
  selectedProfile,
  onSelectProfile,
}: {
  runtime: RuntimeClient;
  trusted: boolean;
  selectedProfile: string;
  onSelectProfile: (profileName: string) => void;
}) {
  const snapshot = runtime.snapshot!;
  const profile = snapshot.profiles.find((candidate) => candidate.name === selectedProfile) ?? snapshot.profiles[0];
  const managed = runtime.session?.mode === "managed" ? runtime.session : null;
  const attached = runtime.session?.mode === "attached" ? runtime.session : null;
  const phase = phaseDetails[snapshot.phase];
  const portAllocation = managed?.endpoint.portAllocation;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>Managed runtime</CardTitle>
          <CardDescription>Larger owns the runtime workspace and every process it starts.</CardDescription>
        </div>
        <ProfilePicker
          profiles={snapshot.profiles}
          selected={profile?.name ?? selectedProfile}
          disabled={runtime.busy || Boolean(managed)}
          onSelect={onSelectProfile}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!trusted && (
          <Alert>
            <AlertCircleIcon />
            <AlertTitle>Trust required</AlertTitle>
            <AlertDescription>Trust this project before running its saved command or editor adapter.</AlertDescription>
          </Alert>
        )}
        {attached && (
          <Alert>
            <LinkIcon />
            <AlertTitle>A preview is already attached</AlertTitle>
            <AlertDescription>Detach the external preview before starting a managed runtime.</AlertDescription>
          </Alert>
        )}
        {profile ? (
          <ItemGroup className="gap-0">
            <RuntimeFact label="Command" value={profile.command.join(" ")} mono />
            <RuntimeFact label="Working directory" value={profile.workingDirectory} mono />
            <RuntimeFact label="Preferred address" value={`${profile.host}:${profile.preferredPort}`} mono />
            <RuntimeFact label="Readiness" value={profile.readinessPath} mono />
            <RuntimeFact label="Runtime adapter" value={profile.runtimeAdapter} />
            <RuntimeFact label="Editor adapter" value={profile.editorAdapter ?? "Preview only"} />
          </ItemGroup>
        ) : (
          <Empty className="min-h-40 border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ServerIcon /></EmptyMedia>
              <EmptyTitle>No runtime profiles</EmptyTitle>
              <EmptyDescription>Add a named runtime profile in project settings.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        <section aria-labelledby="runtime-phase-heading" className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 id="runtime-phase-heading" className="text-sm font-medium">Lifecycle</h3>
            <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
              {runtime.busy && <Spinner />}
              {phase.label}
            </div>
          </div>
          <Progress value={phase.progress} aria-label={`Runtime lifecycle: ${phase.label}`} />
        </section>

        {portAllocation && portAllocation.actual !== portAllocation.preferred && (
          <Alert>
            <ServerIcon />
            <AlertTitle>Preferred port was occupied</AlertTitle>
            <AlertDescription>
              Requested {portAllocation.preferred}; running on {portAllocation.actual}. The preview uses {managed.endpoint.displayUrl}.
            </AlertDescription>
          </Alert>
        )}

        {managed && (
          <ItemGroup className="gap-0">
            <RuntimeFact label="Preview" value={managed.endpoint.displayUrl} mono />
            <RuntimeFact label="Ownership" value="Managed by Larger" />
            <RuntimeFact label="Target process" value={`PID ${managed.target.pid}`} mono />
            <RuntimeFact label="Editor process" value={managed.editor ? `PID ${managed.editor.pid}` : "Not running"} mono />
            <RuntimeFact label="Runtime ID" value={managed.runtimeId} mono />
          </ItemGroup>
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        {runtime.operation?.cancellable ? (
          <Button variant="outline" disabled={runtime.isPending("cancel")} onClick={() => void runtime.cancel()}>
            {runtime.isPending("cancel") ? <Spinner /> : <XIcon data-icon="inline-start" />}
            Cancel
          </Button>
        ) : managed ? (
          <>
            <Button variant="outline" disabled={runtime.busy} onClick={() => void runtime.restart()}>
              <RefreshCwIcon data-icon="inline-start" />Restart
            </Button>
            <Button variant="destructive" disabled={runtime.busy} onClick={() => void runtime.stop()}>
              <SquareIcon data-icon="inline-start" />Stop
            </Button>
          </>
        ) : (
          <Button disabled={runtime.busy || !trusted || !profile || Boolean(attached)} onClick={() => profile && void runtime.start(profile.name)}>
            {runtime.busy ? <Spinner /> : <PlayIcon data-icon="inline-start" />}
            Start
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function AttachPreviewCard({ runtime, trusted }: { runtime: RuntimeClient; trusted: boolean }) {
  const [url, setUrl] = useState("http://127.0.0.1:3000");
  const [validation, setValidation] = useState<string | null>(null);
  const attached = runtime.session?.mode === "attached" ? runtime.session : null;
  const managed = runtime.session?.mode === "managed" ? runtime.session : null;
  const candidates = runtime.snapshot?.discovery?.candidates ?? [];

  const attach = (value: string) => {
    const error = validateAttachUrl(value);
    setValidation(error);
    if (!error) void runtime.attach(value);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    attach(url);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Attach preview</CardTitle>
        <CardDescription>Inspect a development server that is already running on this computer.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Alert>
          <EyeIcon />
          <AlertTitle>Preview only</AlertTitle>
          <AlertDescription>Larger cannot edit files, start an editor adapter, or stop an attached server.</AlertDescription>
        </Alert>
        {!trusted && (
          <Alert>
            <AlertCircleIcon />
            <AlertTitle>Trust this project first</AlertTitle>
            <AlertDescription>Attaching a server is disabled until the project is trusted.</AlertDescription>
          </Alert>
        )}
        {managed && (
          <Alert>
            <ServerIcon />
            <AlertTitle>A managed runtime is already active</AlertTitle>
            <AlertDescription>Stop it before attaching a different preview.</AlertDescription>
          </Alert>
        )}
        {attached ? (
          <ItemGroup className="gap-0">
            <RuntimeFact label="Preview" value={attached.endpoint.displayUrl} mono />
            <RuntimeFact label="Ownership" value="External process — never stopped by Larger" />
            <RuntimeFact label="Editing" value="Disabled" />
          </ItemGroup>
        ) : (
          <form onSubmit={submit}>
            <FieldGroup>
              <Field data-invalid={Boolean(validation) || undefined}>
                <FieldLabel htmlFor="runtime-attach-url">Local server URL</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="runtime-attach-url"
                    value={url}
                    onChange={(event) => {
                      setUrl(event.target.value);
                      if (validation) setValidation(null);
                    }}
                    aria-invalid={Boolean(validation)}
                    aria-describedby="runtime-attach-description"
                    disabled={!trusted || runtime.busy || Boolean(managed)}
                    spellCheck={false}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton type="submit" disabled={!trusted || runtime.busy || Boolean(managed)}>
                      <LinkIcon data-icon="inline-start" />Attach
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription id="runtime-attach-description" role="status" aria-live="polite">
                  {validation ?? "Use http://127.0.0.1 with an explicit port."}
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        )}

        {!attached && runtime.snapshot?.discovery && (
          candidates.length > 0 ? (
            <ItemGroup>
              {candidates.map((candidate) => (
                <Item key={candidate.id} variant="outline">
                  <ItemContent>
                    <ItemTitle>{candidate.label}</ItemTitle>
                    <ItemDescription className="font-mono text-xs">{candidate.url}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {candidate.processId && <Badge variant="outline">PID {candidate.processId}</Badge>}
                    <Button size="sm" variant="outline" disabled={!trusted || runtime.busy || Boolean(managed)} onClick={() => {
                      setUrl(candidate.url);
                      attach(candidate.url);
                    }}>Attach</Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          ) : (
            <Empty className="min-h-36 border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon"><SearchIcon /></EmptyMedia>
                <EmptyTitle>No local servers found</EmptyTitle>
                <EmptyDescription>Enter a loopback URL if the server is using an uncommon port.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        {attached ? (
          <Button variant="outline" disabled={runtime.busy} onClick={() => void runtime.detach()}>
            <UnplugIcon data-icon="inline-start" />Detach
          </Button>
        ) : (
          <Button variant="outline" disabled={!trusted || runtime.busy || Boolean(managed)} onClick={() => void runtime.discover()}>
            {runtime.operation?.kind === "discover" ? <Spinner /> : <SearchIcon data-icon="inline-start" />}
            Discover local servers
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function RuntimeOutput({ runtime }: { runtime: RuntimeClient }) {
  const [filter, setFilter] = useState<LogFilter>("all");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const entries = useMemo(
    () => filterRuntimeLogs(runtime.snapshot?.logWindow.entries ?? [], filter),
    [filter, runtime.snapshot?.logWindow.entries],
  );
  const logWindow = runtime.snapshot?.logWindow;

  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(formatRuntimeLogs(entries));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>Runtime output</CardTitle>
          <CardDescription>Bounded logs are redacted before they reach this window.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">Redacted</Badge>
          <Badge variant="secondary">{logWindow?.retained ?? 0} / {logWindow?.limit ?? 0}</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ToggleGroup
            value={[filter]}
            onValueChange={(next) => {
              const selected = next[0] as LogFilter | undefined;
              if (selected) setFilter(selected);
            }}
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Filter runtime logs"
          >
            <ToggleGroupItem value="all" aria-label="Show all logs">All</ToggleGroupItem>
            <ToggleGroupItem value="runtime" aria-label="Show runtime logs">Runtime</ToggleGroupItem>
            <ToggleGroupItem value="editor" aria-label="Show editor logs">Editor</ToggleGroupItem>
            <ToggleGroupItem value="system" aria-label="Show system logs">System</ToggleGroupItem>
          </ToggleGroup>
          <Button size="sm" variant="outline" disabled={entries.length === 0} onClick={() => void copyLogs()}>
            {copyState === "copied" ? (
              <CheckIcon data-icon="inline-start" />
            ) : copyState === "failed" ? (
              <AlertCircleIcon data-icon="inline-start" />
            ) : (
              <ClipboardIcon data-icon="inline-start" />
            )}
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy logs"}
          </Button>
        </div>
        <div role="status" aria-live="polite" className="sr-only">
          {copyState === "copied" ? "Runtime logs copied" : copyState === "failed" ? "Runtime logs could not be copied" : ""}
        </div>
        {logWindow?.truncated && (
          <Alert>
            <AlertCircleIcon />
            <AlertTitle>Older output was discarded</AlertTitle>
            <AlertDescription>The retained log reached its {logWindow.limit}-entry limit.</AlertDescription>
          </Alert>
        )}
        {entries.length === 0 ? (
          <Empty className="min-h-48 border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ServerIcon /></EmptyMedia>
              <EmptyTitle>No output</EmptyTitle>
              <EmptyDescription>Start or attach a runtime to collect diagnostic output.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="h-72 rounded-lg border bg-muted/30">
            <ol aria-label="Runtime logs" className="flex flex-col gap-1 p-3 font-mono text-xs">
              {entries.map((entry) => (
                <li key={entry.id} className="grid grid-cols-[7rem_4.5rem_minmax(0,1fr)] gap-3">
                  <time className="text-muted-foreground" dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                  <span className="text-muted-foreground">{entry.source}</span>
                  <span className="break-words whitespace-pre-wrap">{entry.message}</span>
                </li>
              ))}
            </ol>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

export function RuntimeWorkspace({
  runtime,
  trusted,
  selectedProfile,
  onSelectProfile,
  onOpenSettings,
  onOpenCanvas,
}: {
  runtime: RuntimeClient;
  trusted: boolean;
  selectedProfile: string;
  onSelectProfile: (profileName: string) => void;
  onOpenSettings: () => void;
  onOpenCanvas: () => void;
}) {
  const [mode, setMode] = useState<RuntimeMode>(runtime.session?.mode ?? "managed");

  useEffect(() => {
    if (runtime.session?.mode) setMode(runtime.session.mode);
  }, [runtime.session?.mode]);

  if (!runtime.hydrated) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6" aria-busy="true">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  if (!runtime.snapshot) {
    return (
      <Empty className="h-full rounded-none">
        <EmptyHeader>
          <EmptyMedia variant="icon"><ServerIcon /></EmptyMedia>
          <EmptyTitle>Runtime controls unavailable</EmptyTitle>
          <EmptyDescription>{runtime.error ?? "The runtime service did not return project state."}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const phase = phaseDetails[runtime.snapshot.phase];
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6" aria-busy={runtime.busy}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Runtime workspace</h2>
            <p className="mt-1 text-sm text-muted-foreground">Start an isolated project profile or attach a preview-only local server.</p>
          </div>
          <div className="flex items-center gap-2">
            {runtime.session && (
              <Button size="sm" variant="outline" onClick={onOpenCanvas}>
                <MonitorPlayIcon data-icon="inline-start" />Open canvas
              </Button>
            )}
            <Badge variant={runtime.snapshot.phase === "failed" ? "destructive" : "secondary"}>{phase.label}</Badge>
          </div>
        </div>

        {(runtime.snapshot.problem || runtime.error) && (
          runtime.snapshot.problem ? (
            <RuntimeProblemAlert
              problem={runtime.snapshot.problem}
              selectedProfile={selectedProfile}
              runtime={runtime}
              onOpenSettings={onOpenSettings}
              onReviewAttach={() => setMode("attached")}
            />
          ) : (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>Runtime operation failed</AlertTitle>
              <AlertDescription>{runtime.error}</AlertDescription>
            </Alert>
          )
        )}

        <Tabs value={mode} onValueChange={(value) => setMode(value as RuntimeMode)}>
          <TabsList>
            <TabsTrigger value="managed"><ServerIcon data-icon="inline-start" />Managed</TabsTrigger>
            <TabsTrigger value="attached"><LinkIcon data-icon="inline-start" />Attach preview</TabsTrigger>
          </TabsList>
          <TabsContent value="managed" className="pt-4">
            <ManagedRuntimeCard
              runtime={runtime}
              trusted={trusted}
              selectedProfile={selectedProfile}
              onSelectProfile={onSelectProfile}
            />
          </TabsContent>
          <TabsContent value="attached" className="pt-4">
            <AttachPreviewCard runtime={runtime} trusted={trusted} />
          </TabsContent>
        </Tabs>

        <Tabs defaultValue="logs">
          <TabsList variant="line">
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
          </TabsList>
          <TabsContent value="logs" className="pt-4"><RuntimeOutput runtime={runtime} /></TabsContent>
          <TabsContent value="diagnostics" className="pt-4">
            <Card>
              <CardHeader>
                <CardTitle>Diagnostics</CardTitle>
                <CardDescription>Current lifecycle, ownership, and recovery information.</CardDescription>
              </CardHeader>
              <CardContent>
                <ItemGroup className="gap-0">
                  <RuntimeFact label="Phase" value={phase.label} />
                  <RuntimeFact label="Operation" value={runtime.operation?.kind ?? "None"} />
                  <RuntimeFact label="Session" value={runtime.session?.mode ?? "None"} />
                  <RuntimeFact label="Ownership" value={runtime.session?.ownership ?? "None"} />
                  <RuntimeFact label="Revision" value={String(runtime.snapshot.revision)} mono />
                </ItemGroup>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </ScrollArea>
  );
}
