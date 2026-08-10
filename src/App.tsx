import { useEffect, useState, type FormEvent } from "react";
import {
  BlocksIcon,
  CheckCircle2Icon,
  ChevronsUpDownIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  ImageIcon,
  InfoIcon,
  LayoutDashboardIcon,
  PaletteIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RouteIcon,
  ServerIcon,
  Settings2Icon,
  ShieldCheckIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import type { ActiveProject, PendingProject, ProjectLifecycleSnapshot } from "@/project-ipc";
import type { ProjectManifest } from "@/project-contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { useProjects } from "@/projects/use-projects";

type ProjectSection = "overview" | "components" | "design-system" | "assets" | "routes" | "servers";

const sections = [
  { id: "overview", label: "Overview", icon: LayoutDashboardIcon },
  { id: "components", label: "Components", icon: BlocksIcon },
  { id: "design-system", label: "Design system", icon: PaletteIcon },
  { id: "assets", label: "Assets", icon: ImageIcon },
  { id: "routes", label: "Routes", icon: RouteIcon },
  { id: "servers", label: "Servers", icon: ServerIcon },
] satisfies Array<{ id: ProjectSection; label: string; icon: typeof LayoutDashboardIcon }>;

function LoadingScreen() {
  return <main className="grid h-screen place-items-center bg-background"><Spinner className="size-5" /></main>;
}

function Welcome({ project }: { project: ReturnType<typeof useProjects> }) {
  const recents = project.snapshot?.recentProjects ?? [];
  return (
    <main className="flex h-screen min-h-0 bg-muted/30">
      <section className="m-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-12">
        <div className="flex flex-col gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl border bg-background shadow-xs">
            <BlocksIcon className="size-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Larger</h1>
            <p className="mt-1 text-sm text-muted-foreground">Open a repository to inspect and design against its real source.</p>
          </div>
          <Button className="mt-2 w-fit" disabled={project.busy} onClick={() => void project.pickAndOpen()}>
            {project.busy ? <Spinner /> : <FolderOpenIcon data-icon="inline-start" />}
            Open project
          </Button>
        </div>

        {project.error && <Alert variant="destructive"><InfoIcon /><AlertTitle>Desktop connection unavailable</AlertTitle><AlertDescription>{project.error}</AlertDescription></Alert>}
        {project.snapshot?.problem && <ProblemAlert snapshot={project.snapshot} />}

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Recent projects</h2>
            <span className="text-xs text-muted-foreground">{recents.length}</span>
          </div>
          {recents.length === 0 ? (
            <Card className="border-dashed shadow-none">
              <Empty className="min-h-48">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><FolderPlusIcon /></EmptyMedia>
                  <EmptyTitle>No recent projects</EmptyTitle>
                  <EmptyDescription>Your repositories stay where they are. Larger stores only local project state.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </Card>
          ) : (
            <ItemGroup>
              {recents.map((recent) => (
                <Item key={recent.instanceKey} variant="outline" className="bg-background">
                  <ItemMedia variant="icon"><FolderOpenIcon /></ItemMedia>
                  <ItemContent>
                    <ItemTitle>{recent.displayName}</ItemTitle>
                    <ItemDescription className="truncate font-mono text-xs">{recent.canonicalPath}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button size="icon-sm" variant="ghost" aria-label={`Remove ${recent.displayName} from recents`} disabled={project.busy} onClick={() => void project.removeRecent(recent.instanceKey)}><Trash2Icon /></Button>
                    <Button size="sm" variant="outline" aria-label={`Open ${recent.displayName}`} disabled={project.busy} onClick={() => void project.openRecent(recent.instanceKey)}>Open</Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
        </section>
      </section>
    </main>
  );
}

function ProblemAlert({ snapshot }: { snapshot: ProjectLifecycleSnapshot }) {
  if (!snapshot.problem) return null;
  const fieldErrors = snapshot.problem.fieldErrors ?? [];
  return (
    <Alert variant={snapshot.problem.code === "internal" ? "destructive" : "default"}>
      <InfoIcon />
      <AlertTitle>Project needs attention</AlertTitle>
      <AlertDescription>
        <p>{snapshot.problem.message}</p>
        {fieldErrors.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {fieldErrors.map((error) => (
              <li key={`${error.path}-${error.code}`}>
                <span className="font-mono text-xs">{error.path}</span>: {error.message}
              </li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}

function ProjectOperationError({ project }: { project: ReturnType<typeof useProjects> }) {
  if (project.snapshot?.problem) return <ProblemAlert snapshot={project.snapshot} />;
  if (!project.error) return null;
  return (
    <Alert variant="destructive">
      <InfoIcon />
      <AlertTitle>Project operation failed</AlertTitle>
      <AlertDescription>{project.error}</AlertDescription>
    </Alert>
  );
}

function SetupProject({ pending, project }: { pending: PendingProject; project: ReturnType<typeof useProjects> }) {
  const initial = pending.suggestedManifest;
  const profile = initial?.runtimeProfiles[initial.defaultRuntimeProfile];
  const [name, setName] = useState(initial?.name ?? pending.displayName);
  const [command, setCommand] = useState<string[]>(profile?.command ?? ["pnpm", "dev"]);
  const [port, setPort] = useState(String(profile?.preferredPort ?? 3000));
  const [entryRoute, setEntryRoute] = useState(profile?.entryRoute ?? "/");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!initial) return;
    const manifest: ProjectManifest = {
      ...initial,
      name: name.trim(),
      runtimeProfiles: {
        ...initial.runtimeProfiles,
        [initial.defaultRuntimeProfile]: {
          ...initial.runtimeProfiles[initial.defaultRuntimeProfile]!,
          command,
          preferredPort: Number(port),
          entryRoute,
        },
      },
    };
    void project.initialize(pending.generation, manifest);
  };

  return (
    <main className="flex h-screen min-h-0 bg-muted/30">
      <Card className="m-auto max-h-[calc(100vh-3rem)] w-full max-w-xl overflow-hidden">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg border bg-background"><Settings2Icon className="size-4" /></div>
          <CardTitle>{pending.reason === "needs-initialization" ? "Set up this project" : "Project configuration"}</CardTitle>
          <CardDescription className="break-all">{pending.canonicalPath}</CardDescription>
        </CardHeader>
        {pending.reason === "unsupported-monorepo" ? (
          <>
            <CardContent className="min-h-0 overflow-y-auto"><Alert><InfoIcon /><AlertTitle>Workspace root detected</AlertTitle><AlertDescription>Choose a package folder inside this workspace. Larger will not guess and initialize the root.</AlertDescription></Alert></CardContent>
            <CardFooter className="justify-between"><Button variant="ghost" onClick={() => void project.dismissPending(pending.generation)}>Cancel</Button><Button variant="outline" onClick={() => void project.pickAndOpen()}>Choose another folder</Button></CardFooter>
          </>
        ) : pending.reason === "invalid-manifest" ? (
          <>
            <CardContent className="min-h-0 overflow-y-auto"><ItemGroup>{pending.fieldErrors.map((error) => <Item key={`${error.path}-${error.code}`} variant="outline"><ItemContent><ItemTitle className="font-mono text-xs">{error.path}</ItemTitle><ItemDescription>{error.message}</ItemDescription></ItemContent></Item>)}</ItemGroup></CardContent>
            <CardFooter className="justify-between"><Button variant="ghost" onClick={() => void project.dismissPending(pending.generation)}>Cancel</Button><div className="flex gap-2"><Button variant="ghost" onClick={() => void project.pickAndOpen()}>Choose another folder</Button><Button variant="outline" onClick={() => void project.refresh(pending.generation)}><RefreshCwIcon data-icon="inline-start" />Retry after editing</Button></div></CardFooter>
          </>
        ) : (
          <form className="flex min-h-0 flex-col overflow-hidden" onSubmit={submit}>
            <CardContent className="min-h-0 overflow-y-auto">
              <FieldGroup>
                <ProjectOperationError project={project} />
                <DetectionReview pending={pending} />
                <Field><FieldLabel htmlFor="project-name">Name</FieldLabel><Input id="project-name" value={name} onChange={(event) => setName(event.target.value)} required /></Field>
                <CommandArgumentsEditor id="project-command" value={command} onChange={setCommand} />
                <FieldGroup className="grid grid-cols-2 gap-4">
                  <Field><FieldLabel htmlFor="project-port">Port</FieldLabel><Input id="project-port" type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(event.target.value)} required /></Field>
                  <Field><FieldLabel htmlFor="project-route">Entry route</FieldLabel><Input id="project-route" value={entryRoute} onChange={(event) => setEntryRoute(event.target.value)} required /></Field>
                </FieldGroup>
              </FieldGroup>
            </CardContent>
            <CardFooter className="justify-between">
              <div className="flex gap-2"><Button type="button" variant="ghost" onClick={() => void project.dismissPending(pending.generation)}>Cancel</Button><Button type="button" variant="ghost" onClick={() => void project.pickAndOpen()}>Choose another folder</Button></div>
              <Button type="submit" disabled={project.busy}>{project.busy ? <Spinner /> : <CheckCircle2Icon data-icon="inline-start" />}Initialize</Button>
            </CardFooter>
          </form>
        )}
      </Card>
    </main>
  );
}

function DetectionReview({ pending }: { pending: PendingProject }) {
  const detection = pending.detection;
  const facts = [
    ["Package manager", detection.packageManager],
    ["Framework", detection.framework],
    ["Tailwind", detection.tailwind],
    ["ShadCN", detection.shadcn],
    ["Git", detection.git],
  ] as const;
  return (
    <Field>
      <FieldLabel>Detected project</FieldLabel>
      <ItemGroup className="gap-0 rounded-md border px-3">
        {facts.map(([label, value]) => (
          <Item key={label} size="xs" className="rounded-none px-0">
            <ItemContent>
              <ItemTitle className="text-xs">{label}</ItemTitle>
              {value.evidence.length > 0 && <ItemDescription className="truncate text-xs">{value.evidence.join(", ")}</ItemDescription>}
            </ItemContent>
            <ItemActions><Badge variant={value.status === "ambiguous" ? "outline" : "secondary"}>{detectionLabel(value)}</Badge></ItemActions>
          </Item>
        ))}
      </ItemGroup>
      <FieldDescription>Confirm these passive detections before Larger writes project configuration.</FieldDescription>
    </Field>
  );
}

function CommandArgumentsEditor({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const update = (index: number, argument: string) => onChange(value.map((current, currentIndex) => (
    currentIndex === index ? argument : current
  )));
  const remove = (index: number) => onChange(value.filter((_, currentIndex) => currentIndex !== index));
  return (
    <Field>
      <FieldLabel htmlFor={`${id}-0`}>Development command arguments</FieldLabel>
      <FieldGroup>
        {value.map((argument, index) => (
          <div key={`${id}-${index}`} className="flex items-center gap-2">
            <Input
              id={`${id}-${index}`}
              aria-label={index === 0 ? "Executable" : `Argument ${index}`}
              value={argument}
              onChange={(event) => update(index, event.target.value)}
              required
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove argument ${index + 1}`}
              disabled={value.length === 1}
              onClick={() => remove(index)}
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
      </FieldGroup>
      <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => onChange([...value, ""])}>
        <PlusIcon data-icon="inline-start" />Add argument
      </Button>
      <FieldDescription>The executable is first. Each argument is stored separately and exactly as entered.</FieldDescription>
    </Field>
  );
}

function detectionLabel(value: { status: string; value?: unknown; reason?: string; candidates?: unknown[] }): string {
  if (value.status === "detected") return typeof value.value === "string" ? value.value : "Detected";
  if (value.status === "ambiguous") {
    return (value.candidates ?? []).map((candidate) => (
      typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : JSON.stringify(candidate)
    )).join(" or ") || "Ambiguous";
  }
  if (value.status === "deferred") return value.reason ?? "Deferred";
  return "Not detected";
}

function ProjectOverview({ active }: { active: ActiveProject }) {
  const detection = active.detection;
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
        <div><h2 className="text-xl font-semibold tracking-tight">Project overview</h2><p className="mt-1 text-sm text-muted-foreground">Passive repository detection and project-owned configuration.</p></div>
        <div className="grid gap-4 md:grid-cols-2">
          <Card><CardHeader><CardTitle>Stack</CardTitle><CardDescription>Detected without running repository code</CardDescription></CardHeader><CardContent><ItemGroup className="gap-0"><Fact label="Framework" value={detectionLabel(detection.framework)} /><Fact label="Package manager" value={detectionLabel(detection.packageManager)} /><Fact label="Tailwind" value={detectionLabel(detection.tailwind)} /><Fact label="ShadCN" value={detectionLabel(detection.shadcn)} /></ItemGroup></CardContent></Card>
          <Card><CardHeader><CardTitle>Configuration</CardTitle><CardDescription>Stored in .larger/project.json</CardDescription></CardHeader><CardContent><ItemGroup className="gap-0"><Fact label="Project ID" value={active.manifest.projectId} mono /><Fact label="Default profile" value={active.manifest.defaultRuntimeProfile} /><Fact label="Trust" value={active.trust} /><Fact label="Git" value={detectionLabel(detection.git)} /></ItemGroup></CardContent></Card>
        </div>
        {active.workspace && <Alert><CheckCircle2Icon /><AlertTitle>Runtime workspace prepared</AlertTitle><AlertDescription>Immutable baseline {active.workspace.baselineIdentity.slice(0, 12)} is ready in application data.</AlertDescription></Alert>}
      </div>
    </ScrollArea>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <Item size="xs" className="rounded-none px-0"><ItemContent><ItemDescription>{label}</ItemDescription></ItemContent><ItemActions><span className={mono ? "max-w-64 truncate font-mono text-xs" : "text-xs"} title={value}>{value}</span></ItemActions></Item>;
}

function PlaceholderSection({ section }: { section: Exclude<ProjectSection, "overview"> }) {
  const details = {
    components: [BlocksIcon, "Components", "No components have been indexed yet."],
    "design-system": [PaletteIcon, "Design system", "Brand tokens and reusable styles will live here."],
    assets: [ImageIcon, "Assets", "Project assets will be indexed without moving them from source."],
    routes: [RouteIcon, "Routes", "Route discovery will follow the selected workspace package."],
    servers: [ServerIcon, "Servers", "No development servers are running."],
  }[section] as [typeof BlocksIcon, string, string];
  const [Icon, title, description] = details;
  return <Empty className="h-full rounded-none"><EmptyHeader><EmptyMedia variant="icon"><Icon /></EmptyMedia><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader></Empty>;
}

function TrustControl({ active, project }: { active: ActiveProject; project: ReturnType<typeof useProjects> }) {
  if (active.trust === "trusted") return <Badge variant="secondary"><ShieldCheckIcon />Trusted</Badge>;
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button size="sm" variant="outline" />}><ShieldCheckIcon data-icon="inline-start" />Review trust</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Trust {active.manifest.name}?</AlertDialogTitle><AlertDialogDescription>Opening was passive. Trust is required before Larger may run the saved development command or editor adapter inside a managed runtime workspace.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel onClick={() => void project.setTrust(active.generation, "denied")}>Do not trust</AlertDialogCancel><AlertDialogAction onClick={() => void project.setTrust(active.generation, "trusted")}>Trust project</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ProjectSettingsControl({ active, project }: { active: ActiveProject; project: ReturnType<typeof useProjects> }) {
  const [open, setOpen] = useState(false);
  const profile = active.manifest.runtimeProfiles[active.manifest.defaultRuntimeProfile]!;
  const [name, setName] = useState(active.manifest.name);
  const [command, setCommand] = useState<string[]>([...profile.command]);
  const [port, setPort] = useState(String(profile.preferredPort));
  const [entryRoute, setEntryRoute] = useState(profile.entryRoute);

  const resetDraft = () => {
    setName(active.manifest.name);
    setCommand([...profile.command]);
    setPort(String(profile.preferredPort));
    setEntryRoute(profile.entryRoute);
  };

  const changeOpen = (nextOpen: boolean) => {
    if (nextOpen && !open) resetDraft();
    setOpen(nextOpen);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const manifest: ProjectManifest = {
      ...active.manifest,
      name: name.trim(),
      runtimeProfiles: {
        ...active.manifest.runtimeProfiles,
        [active.manifest.defaultRuntimeProfile]: {
          ...profile,
          command,
          preferredPort: Number(port),
          entryRoute,
        },
      },
    };
    const result = await project.updateManifest(active.generation, manifest);
    if (result?.status === "completed" && !result.snapshot.problem) setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Project settings" />}><Settings2Icon data-icon="inline-start" /></DialogTrigger>
      <DialogContent className="max-h-[calc(100vh-3rem)] overflow-hidden">
        <form className="flex min-h-0 flex-col overflow-hidden" onSubmit={save}>
          <DialogHeader><DialogTitle>Project settings</DialogTitle><DialogDescription>Updates the versioned .larger/project.json file. The stable project ID stays unchanged.</DialogDescription></DialogHeader>
          <ProjectOperationError project={project} />
          <div className="min-h-0 overflow-y-auto py-5 pr-1"><FieldGroup>
              <Field><FieldLabel htmlFor="settings-name">Name</FieldLabel><Input id="settings-name" value={name} onChange={(event) => setName(event.target.value)} required /></Field>
              <CommandArgumentsEditor id="settings-command" value={command} onChange={setCommand} />
              <FieldGroup className="grid grid-cols-2 gap-4"><Field><FieldLabel htmlFor="settings-port">Port</FieldLabel><Input id="settings-port" type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(event.target.value)} required /></Field><Field><FieldLabel htmlFor="settings-route">Entry route</FieldLabel><Input id="settings-route" value={entryRoute} onChange={(event) => setEntryRoute(event.target.value)} required /></Field></FieldGroup>
            </FieldGroup></div>
          <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={project.busy}>Save settings</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectStudio({ active, project }: { active: ActiveProject; project: ReturnType<typeof useProjects> }) {
  const [section, setSection] = useState<ProjectSection>(active.personalState.selectedSection ?? "overview");
  const selectSection = (next: ProjectSection) => {
    setSection(next);
    void project.updatePersonalState(active.generation, { ...active.personalState, selectedSection: next });
  };
  useEffect(() => window.largerCanvas?.hide(), [active.identity.instanceKey, section]);
  return (
    <SidebarProvider className="h-screen min-h-0 overflow-hidden">
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <DropdownMenu>
            <DropdownMenuTrigger render={<SidebarMenuButton size="lg" tooltip="Project" />}>
              <div className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"><BlocksIcon className="size-4" /></div>
              <div className="min-w-0 flex-1 text-left"><div className="truncate text-sm font-medium">{active.manifest.name}</div><div className="truncate text-xs text-muted-foreground">{active.identity.canonicalPath}</div></div>
              <ChevronsUpDownIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-72" align="start"><DropdownMenuGroup><DropdownMenuLabel>Project</DropdownMenuLabel><DropdownMenuItem disabled={project.busy} onClick={() => void project.pickAndOpen()}><FolderOpenIcon data-icon="inline-start" />Open another project</DropdownMenuItem><DropdownMenuItem disabled={project.busy} onClick={() => void project.refresh(active.generation)}><RefreshCwIcon data-icon="inline-start" />Refresh detection</DropdownMenuItem></DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuGroup><DropdownMenuItem disabled={project.busy} variant="destructive" onClick={() => void project.close(active.generation)}><XIcon data-icon="inline-start" />Close project</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent>
          </DropdownMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup><SidebarGroupLabel>Project</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{sections.slice(0, 1).map(({ id, label, icon: Icon }) => <SidebarMenuItem key={id}><SidebarMenuButton disabled={project.busy} isActive={section === id} tooltip={label} onClick={() => selectSection(id)}><Icon /><span>{label}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup>
          <SidebarGroup><SidebarGroupLabel>Library</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{sections.slice(1, 5).map(({ id, label, icon: Icon }) => <SidebarMenuItem key={id}><SidebarMenuButton disabled={project.busy} isActive={section === id} tooltip={label} onClick={() => selectSection(id)}><Icon /><span>{label}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup>
          <SidebarGroup><SidebarGroupLabel>Runtime</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{sections.slice(5).map(({ id, label, icon: Icon }) => <SidebarMenuItem key={id}><SidebarMenuButton disabled={project.busy} isActive={section === id} tooltip={label} onClick={() => selectSection(id)}><Icon /><span>{label}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup>
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-h-0 min-w-0">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4"><SidebarTrigger /><Separator orientation="vertical" className="h-4" /><div className="min-w-0 flex-1"><h1 className="truncate text-sm font-medium">{sections.find((item) => item.id === section)?.label}</h1></div>{project.snapshot?.transition && <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" />{project.snapshot.transition.kind.replaceAll("-", " ")}</div>}<ProjectSettingsControl active={active} project={project} /><TrustControl active={active} project={project} /></header>
        {(project.snapshot?.problem || project.error) && <div className="px-4 pt-4">{project.snapshot?.problem ? <ProblemAlert snapshot={project.snapshot} /> : <Alert variant="destructive"><InfoIcon /><AlertTitle>Project operation failed</AlertTitle><AlertDescription>{project.error}</AlertDescription></Alert>}</div>}
        <div className="min-h-0 flex-1">{section === "overview" ? <ProjectOverview active={active} /> : <PlaceholderSection section={section} />}</div>
        <footer className="flex h-10 shrink-0 items-center justify-between border-t px-4 text-xs text-muted-foreground"><span className="truncate font-mono">{active.identity.canonicalPath}</span>{active.trust === "trusted" && !active.workspace && <Button size="xs" variant="ghost" disabled={project.busy} onClick={() => void project.prepareWorkspace(active.generation)}><PlayIcon data-icon="inline-start" />Prepare workspace</Button>}</footer>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function App() {
  const project = useProjects();
  const snapshot = project.snapshot;
  if (!snapshot) return <LoadingScreen />;
  if (snapshot.pending) return <SetupProject key={snapshot.pending.canonicalPath} pending={snapshot.pending} project={project} />;
  if (snapshot.active) return <ProjectStudio key={snapshot.active.identity.instanceKey} active={snapshot.active} project={project} />;
  return <Welcome project={project} />;
}
