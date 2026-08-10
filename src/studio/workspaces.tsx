import type { FormEvent, RefObject } from "react";
import {
  ArrowRightIcon,
  BoxIcon,
  BracesIcon,
  CircleStopIcon,
  ComponentIcon,
  FileCodeIcon,
  ImageIcon,
  LaptopIcon,
  MonitorIcon,
  MonitorPlayIcon,
  PaletteIcon,
  PlayIcon,
  RefreshCwIcon,
  RouteIcon,
  ServerIcon,
  SmartphoneIcon,
  TabletIcon,
  TerminalIcon,
} from "lucide-react";
import type {
  BrandToken,
  ProjectAsset,
  ProjectComponent,
  ProjectSummary,
  SessionSnapshot,
} from "@/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { StudioSelection, Viewport } from "./types";
import { phaseLabel } from "./status";
import { formatBytes } from "./format";

const VIEWPORTS: Record<Viewport, { label: string; width: number | null; icon: typeof MonitorIcon }> = {
  desktop: { label: "Desktop", width: null, icon: MonitorIcon },
  tablet: { label: "Tablet", width: 820, icon: TabletIcon },
  mobile: { label: "Mobile", width: 390, icon: SmartphoneIcon },
};

function WorkspaceHeader({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: typeof ComponentIcon;
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex min-h-16 items-center gap-3 border-b px-5 py-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-medium">{title}</h1>
        <p className="truncate text-xs text-muted-foreground">{description}</p>
      </div>
      {actions}
    </header>
  );
}

function EmptyInventory({ label }: { label: string }) {
  return (
    <Empty className="min-h-72 border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><BoxIcon /></EmptyMedia>
        <EmptyTitle>No {label.toLowerCase()} found</EmptyTitle>
        <EmptyDescription>The project scanner did not find any in the configured source tree.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function PartialScanBadge({ visible }: { visible: boolean }) {
  return visible ? <Badge variant="outline">Partial scan</Badge> : null;
}

export function ComponentsWorkspace({
  project,
  selection,
  onSelect,
}: {
  project: ProjectSummary | null;
  selection: StudioSelection;
  onSelect: (selection: StudioSelection) => void;
}) {
  const groups = project ? [
    { label: "UI components", items: project.components.filter((item) => item.family === "ui") },
    { label: "Project", items: project.components.filter((item) => item.family === "project") },
  ] : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader
        icon={ComponentIcon}
        title="Components"
        description="Reusable React building blocks discovered in the project"
        actions={<PartialScanBadge visible={Boolean(project?.truncated.files)} />}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-6">
          {!project ? (
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 8 }).map((_, index) => <Skeleton className="h-20" key={index} />)}
            </div>
          ) : project.components.length === 0 ? <EmptyInventory label="Components" /> : groups.map((group) => (
            group.items.length > 0 && (
              <section className="flex flex-col gap-3" key={group.label}>
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.label}</h2>
                  <span className="text-xs tabular-nums text-muted-foreground">{group.items.length}</span>
                </div>
                <ItemGroup className="grid grid-cols-2 gap-3 xl:grid-cols-3">
                  {group.items.map((component) => (
                    <ComponentItem
                      component={component}
                      isSelected={selection?.kind === "component" && selection.value.file === component.file}
                      key={component.file}
                      onSelect={() => onSelect({ kind: "component", value: component })}
                    />
                  ))}
                </ItemGroup>
              </section>
            )
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function ComponentItem({
  component,
  isSelected,
  onSelect,
}: {
  component: ProjectComponent;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <Item
      role="listitem"
      variant={isSelected ? "muted" : "outline"}
      className="relative min-w-0 flex-nowrap text-left hover:bg-muted/50"
    >
      <Button
        aria-label={`Inspect ${component.name}`}
        aria-pressed={isSelected}
        className="absolute inset-0 z-10 h-auto w-auto rounded-lg p-0 hover:bg-transparent"
        variant="ghost"
        onClick={onSelect}
      />
      <ItemMedia variant="icon" className="size-9 rounded-lg border bg-background">
        <ComponentIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>{component.name}</ItemTitle>
        <ItemDescription className="truncate font-mono text-xs">{component.file}</ItemDescription>
      </ItemContent>
    </Item>
  );
}

export function DesignSystemWorkspace({
  project,
  selection,
  onSelect,
}: {
  project: ProjectSummary | null;
  selection: StudioSelection;
  onSelect: (selection: StudioSelection) => void;
}) {
  const lightTokens = project?.brand.tokens.filter((token) => token.mode === "light") ?? [];
  const darkTokens = project?.brand.tokens.filter((token) => token.mode === "dark") ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader
        icon={PaletteIcon}
        title="Design system"
        description="Colors, typography, Tailwind, and ShadCN metadata from source"
        actions={<PartialScanBadge visible={Boolean(project?.truncated.css)} />}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
          {!project ? <Skeleton className="h-36" /> : (
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Foundation</CardTitle>
                  <CardDescription>Detected project styling infrastructure</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm">
                  <Fact label="Tailwind" value={project.brand.tailwindConfig ?? "Not found"} />
                  <Fact label="ShadCN" value={project.brand.shadcn.detected ? project.brand.shadcn.style ?? "Detected" : "Not found"} />
                  <Fact label="Icons" value={project.brand.shadcn.iconLibrary ?? "Not specified"} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Typography</CardTitle>
                  <CardDescription>{project.brand.fonts.length} font families discovered</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {project.brand.fonts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No font declarations found.</p>
                  ) : project.brand.fonts.map((font) => (
                    <div className="flex items-center gap-3" key={font.family}>
                      <div className="flex size-10 items-center justify-center rounded-lg border bg-muted/40 text-lg">Ag</div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{font.family}</p>
                        <p className="truncate text-xs text-muted-foreground">{font.weights.join(", ") || "Weights not declared"}</p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          )}
          {project && project.brand.tokens.length === 0 ? <EmptyInventory label="Tokens" /> : (
            <div className="grid gap-6 xl:grid-cols-2">
              <TokenSection label="Light" tokens={lightTokens} selection={selection} onSelect={onSelect} />
              <TokenSection label="Dark" tokens={darkTokens} selection={selection} onSelect={onSelect} />
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b pb-2 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-xs" title={value}>{value}</span>
    </div>
  );
}

function TokenSection({
  label,
  tokens,
  selection,
  onSelect,
}: {
  label: string;
  tokens: BrandToken[];
  selection: StudioSelection;
  onSelect: (selection: StudioSelection) => void;
}) {
  if (tokens.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label} tokens</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{tokens.length}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {tokens.map((token) => {
          const selected = selection?.kind === "token" && selection.value.name === token.name && selection.value.mode === token.mode;
          return (
            <Button
              variant={selected ? "secondary" : "outline"}
              className="h-auto min-w-0 justify-start px-2.5 py-2 text-left"
              key={`${token.mode}-${token.name}-${token.value}`}
              onClick={() => onSelect({ kind: "token", value: token })}
            >
              <span className="size-7 shrink-0 rounded-md border" style={{ background: token.value }} />
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">{token.name.replace(/^--/, "")}</span>
                <span className="block truncate font-mono text-[10px] font-normal text-muted-foreground">{token.value}</span>
              </span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}

export function AssetsWorkspace({
  project,
  selection,
  onSelect,
}: {
  project: ProjectSummary | null;
  selection: StudioSelection;
  onSelect: (selection: StudioSelection) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader
        icon={ImageIcon}
        title="Assets"
        description="Images, icons, fonts, and files available to designs"
        actions={<PartialScanBadge visible={Boolean(project?.truncated.assets)} />}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-5xl p-6">
          {!project ? <Skeleton className="h-80" /> : project.assets.length === 0 ? <EmptyInventory label="Assets" /> : (
            <ItemGroup className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
              {project.assets.map((asset) => <AssetItem
                asset={asset}
                isSelected={selection?.kind === "asset" && selection.value.path === asset.path}
                key={asset.path}
                onSelect={() => onSelect({ kind: "asset", value: asset })}
              />)}
            </ItemGroup>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function AssetItem({ asset, isSelected, onSelect }: { asset: ProjectAsset; isSelected: boolean; onSelect: () => void }) {
  return (
    <Item
      role="listitem"
      variant={isSelected ? "muted" : "outline"}
      className="relative min-w-0 flex-nowrap text-left hover:bg-muted/50"
    >
      <Button
        aria-label={`Inspect ${asset.name}`}
        aria-pressed={isSelected}
        className="absolute inset-0 z-10 h-auto w-auto rounded-lg p-0 hover:bg-transparent"
        variant="ghost"
        onClick={onSelect}
      />
      <ItemMedia variant={asset.previewUrl ? "image" : "icon"} className="size-10 rounded-md border bg-muted/40">
        {asset.previewUrl ? <img src={asset.previewUrl} alt="" loading="lazy" /> : <FileCodeIcon />}
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>{asset.name}</ItemTitle>
        <ItemDescription>{formatBytes(asset.bytes)} · {asset.kind}</ItemDescription>
      </ItemContent>
    </Item>
  );
}

export function RoutesWorkspace({
  project,
  selection,
  onSelect,
  onOpen,
}: {
  project: ProjectSummary | null;
  selection: StudioSelection;
  onSelect: (selection: StudioSelection) => void;
  onOpen: (route: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader
        icon={RouteIcon}
        title="Routes"
        description="Pages discovered in the project router"
        actions={<PartialScanBadge visible={Boolean(project?.truncated.files)} />}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl p-6">
          {!project ? <Skeleton className="h-72" /> : project.routes.length === 0 ? <EmptyInventory label="Routes" /> : (
            <ItemGroup className="gap-2">
              {project.routes.map((route) => (
                <Item
                  role="listitem"
                  variant={selection?.kind === "route" && selection.value.file === route.file ? "muted" : "outline"}
                  key={route.file}
                  className="relative flex-nowrap"
                >
                  <Button
                    aria-label={`Inspect route ${route.path}`}
                    aria-pressed={selection?.kind === "route" && selection.value.file === route.file}
                    className="absolute inset-0 z-10 h-auto w-auto rounded-lg p-0 hover:bg-transparent"
                    variant="ghost"
                    onClick={() => onSelect({ kind: "route", value: route })}
                  />
                  <ItemMedia variant="icon"><RouteIcon /></ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="font-mono">{route.path}</ItemTitle>
                    <ItemDescription className="truncate font-mono text-xs">{route.file}</ItemDescription>
                  </ItemContent>
                  <ItemActions className="relative z-20">
                    <Badge variant="outline">{route.kind}</Badge>
                    <Tooltip>
                      <TooltipTrigger render={
                        <Button
                          aria-disabled={route.kind === "dynamic"}
                          aria-label={`Open ${route.path} in canvas`}
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => {
                            if (route.kind !== "dynamic") onOpen(route.path);
                          }}
                        />
                      }>
                        <MonitorPlayIcon />
                      </TooltipTrigger>
                      <TooltipContent>
                        {route.kind === "dynamic" ? "Dynamic routes need fixture data" : "Open in canvas"}
                      </TooltipContent>
                    </Tooltip>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export function ServersWorkspace({
  session,
  address,
  onAddressChange,
  canStart,
  onStart,
  onStop,
}: {
  session: SessionSnapshot;
  address: string;
  onAddressChange: (address: string) => void;
  canStart: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const isBusy = ["preparing", "starting-target", "starting-adapter", "stopping"].includes(session.phase);
  const isStarting = ["preparing", "starting-target", "starting-adapter"].includes(session.phase);
  const running = session.phase === "ready";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader icon={ServerIcon} title="Servers" description="Launch, inspect, and stop the managed project runtime" />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><LaptopIcon className="size-4" /> Project dev server</CardTitle>
              <CardDescription>Managed in an isolated working copy for this session.</CardDescription>
              <CardAction>
                <Badge variant={running ? "default" : session.phase === "error" ? "destructive" : "outline"}>
                  {phaseLabel(session.phase)}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <Field>
                <FieldLabel htmlFor="server-address">Launch address</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="server-address"
                    readOnly={running || isBusy}
                    aria-readonly={running || isBusy}
                    inputMode="url"
                    spellCheck={false}
                    value={address}
                    onChange={(event) => onAddressChange(event.target.value)}
                  />
                </InputGroup>
                <FieldDescription>Use localhost or 127.0.0.1 with a preferred port. If occupied, Larger chooses the next free port.</FieldDescription>
              </Field>
              <div className="flex flex-col gap-3">
                <Fact
                  label={session.server.active ? "Command" : "Command template"}
                  value={(session.server.active?.command ?? session.server.configured.command).join(" ")}
                />
                <Fact label="Editor" value={`${session.adapter.name}${session.adapter.version ? ` ${session.adapter.version}` : ""}`} />
                <Fact label="Active target" value={session.server.active?.url ?? "—"} />
                <Fact label="Editor surface" value={session.surface?.url ?? "—"} />
              </div>
            </CardContent>
            <CardFooter className="justify-between gap-3">
              <p className="text-xs text-muted-foreground">Only processes started by Larger can be stopped here.</p>
              {running || isStarting || session.phase === "stopping" ? (
                <Button variant={running ? "destructive" : "outline"} disabled={session.phase === "stopping"} onClick={onStop}>
                  <CircleStopIcon data-icon="inline-start" />
                  {session.phase === "stopping" ? "Stopping" : isStarting ? "Cancel launch" : "Stop server"}
                </Button>
              ) : (
                <Button disabled={!canStart || isBusy} onClick={onStart}>
                  <PlayIcon data-icon="inline-start" />{isBusy ? "Starting" : "Launch session"}
                </Button>
              )}
            </CardFooter>
          </Card>

          <Tabs defaultValue="output" className="min-h-64">
            <TabsList variant="line">
              <TabsTrigger value="output"><TerminalIcon data-icon="inline-start" />Output</TabsTrigger>
              <TabsTrigger value="changes"><BracesIcon data-icon="inline-start" />Sandbox changes</TabsTrigger>
            </TabsList>
            <TabsContent value="output" className="rounded-xl border bg-card">
              <ScrollArea className="h-64">
                <div className="flex flex-col gap-2 p-4 font-mono text-xs">
                  {session.logs.length === 0 ? <p className="text-muted-foreground">Launch the project to see server output.</p> : [...session.logs].reverse().map((log, index) => (
                    <div className="grid grid-cols-[64px_1fr] gap-3" key={`${log.at}-${index}`}>
                      <span className="uppercase text-muted-foreground">{log.source}</span>
                      <span className="break-words text-foreground/80">{log.message}</span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="changes" className="rounded-xl border bg-card">
              <div className="p-4">
                {session.changes.length === 0 ? <p className="text-sm text-muted-foreground">No sandbox changes.</p> : (
                  <ItemGroup className="gap-1">
                    {session.changes.map((change) => (
                      <Item role="listitem" size="xs" key={change.file}>
                        <ItemMedia><Badge variant="outline">{change.status[0].toUpperCase()}</Badge></ItemMedia>
                        <ItemContent><ItemTitle className="font-mono text-xs">{change.file}</ItemTitle></ItemContent>
                      </Item>
                    ))}
                  </ItemGroup>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </ScrollArea>
    </div>
  );
}

export function CanvasWorkspace({
  project,
  session,
  canvasMountRef,
  nativeAvailable,
  routeDraft,
  viewport,
  onRouteDraftChange,
  onRouteSubmit,
  onViewportChange,
  onReload,
  canStart,
  onStart,
  onStop,
}: {
  project: ProjectSummary | null;
  session: SessionSnapshot;
  canvasMountRef: RefObject<HTMLDivElement | null>;
  nativeAvailable: boolean;
  routeDraft: string;
  viewport: Viewport;
  onRouteDraftChange: (value: string) => void;
  onRouteSubmit: (event: FormEvent) => void;
  onViewportChange: (viewport: Viewport) => void;
  onReload: () => void;
  canStart: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const canvasReady = session.phase === "ready" && session.surface?.kind === "web-url";
  const isStarting = ["preparing", "starting-target", "starting-adapter"].includes(session.phase);
  const viewportWidth = VIEWPORTS[viewport].width;
  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      <header className="flex min-h-12 items-center gap-3 border-b bg-background px-3">
        <form className="w-full max-w-xs" onSubmit={onRouteSubmit}>
          <InputGroup>
            <InputGroupInput
              aria-label="Canvas route"
              disabled={!canvasReady}
              value={routeDraft}
              spellCheck={false}
              onChange={(event) => onRouteDraftChange(event.target.value)}
            />
            <InputGroupAddon><RouteIcon /></InputGroupAddon>
            <InputGroupAddon align="inline-end">
              <InputGroupButton aria-label="Open route" disabled={!canvasReady} size="icon-xs" type="submit">
                <ArrowRightIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
        <div className="flex flex-1 justify-center">
          <ToggleGroup
            aria-label="Viewport size"
            value={[viewport]}
            variant="outline"
            size="sm"
            spacing={0}
            onValueChange={(values) => {
              const next = values[0] as Viewport | undefined;
              if (next) onViewportChange(next);
            }}
          >
            {(Object.keys(VIEWPORTS) as Viewport[]).map((key) => {
              const Icon = VIEWPORTS[key].icon;
              return <ToggleGroupItem aria-label={VIEWPORTS[key].label} key={key} value={key}><Icon /></ToggleGroupItem>;
            })}
          </ToggleGroup>
        </div>
        <div className="flex w-full max-w-xs justify-end">
          <Tooltip>
            <TooltipTrigger render={<Button aria-label="Reload canvas" size="icon-sm" variant="ghost" disabled={!canvasReady} onClick={onReload} />}>
              <RefreshCwIcon />
            </TooltipTrigger>
            <TooltipContent>Reload canvas</TooltipContent>
          </Tooltip>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-[radial-gradient(circle_at_center,var(--border)_1px,transparent_1px)] bg-size-[16px_16px] p-6">
        <div
          className="relative h-full min-h-[480px] max-w-full overflow-hidden border bg-background"
          style={{ width: viewportWidth ? `${viewportWidth}px` : "100%" }}
        >
          <div className="relative size-full min-h-0" ref={canvasMountRef}>
            {!canvasReady && (
              <Empty className="absolute inset-0 rounded-none border-0 bg-background text-foreground">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><MonitorPlayIcon /></EmptyMedia>
                  <EmptyTitle>{project?.name ?? "Reading project"}</EmptyTitle>
                  <EmptyDescription>Launch the managed server to inspect and edit the running application.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  {isStarting || session.phase === "stopping" ? (
                    <Button variant="outline" disabled={session.phase === "stopping"} onClick={onStop}>
                      <CircleStopIcon data-icon="inline-start" />{session.phase === "stopping" ? "Stopping" : "Cancel launch"}
                    </Button>
                  ) : (
                    <Button disabled={!project || !canStart || session.phase !== "idle" && session.phase !== "error"} onClick={onStart}>
                      <PlayIcon data-icon="inline-start" />Launch canvas
                    </Button>
                  )}
                </EmptyContent>
              </Empty>
            )}
            {canvasReady && !nativeAvailable && (
              <div className="absolute inset-0 grid place-items-center bg-background p-6 text-foreground">
                <Alert className="max-w-md">
                  <MonitorPlayIcon />
                  <AlertTitle>Electron required</AlertTitle>
                  <AlertDescription>The active editor adapter requested a native browser surface.</AlertDescription>
                </Alert>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
