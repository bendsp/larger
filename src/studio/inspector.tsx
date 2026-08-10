import {
  ComponentIcon,
  ImageIcon,
  MousePointer2Icon,
  RouteIcon,
  ServerIcon,
} from "lucide-react";
import type { SessionSnapshot } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { StudioSelection, Workspace } from "./types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Property({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[80px_minmax(0,1fr)] gap-3 py-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`m-0 min-w-0 break-words text-right ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1 px-4 py-3">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <dl className="m-0 divide-y">{children}</dl>
    </section>
  );
}

function EmptyInspector({ workspace, adapterName }: { workspace: Workspace; adapterName: string }) {
  const canvas = workspace === "canvas";
  return (
    <Empty className="h-full rounded-none border-0 px-5">
      <EmptyHeader>
        <EmptyMedia variant="icon"><MousePointer2Icon /></EmptyMedia>
        <EmptyTitle>{canvas ? "No element selected" : "Nothing selected"}</EmptyTitle>
        <EmptyDescription>
          {canvas
            ? `Select an element in the canvas. ${adapterName || "The active adapter"} currently owns its embedded inspector until selection data is exposed to Larger.`
            : "Choose an item in the workspace to inspect its source details."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function Inspector({
  workspace,
  selection,
  session,
}: {
  workspace: Workspace;
  selection: StudioSelection;
  session: SessionSnapshot;
}) {
  return (
    <aside className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex min-h-16 items-center justify-between border-b px-4">
        <div>
          <h2 className="text-sm font-medium">Inspector</h2>
          <p className="text-xs text-muted-foreground">Selection details</p>
        </div>
        {selection && <Badge variant="outline">{selection.kind}</Badge>}
      </header>
      <div className="min-h-0 flex-1">
        {!selection ? <EmptyInspector workspace={workspace} adapterName={session.adapter.name} /> : (
          <ScrollArea className="h-full">
            {selection.kind === "component" && (
              <>
                <div className="flex items-center gap-3 p-4">
                  <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/40"><ComponentIcon className="size-4" /></div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{selection.value.name}</p>
                    <p className="text-xs text-muted-foreground">React component</p>
                  </div>
                </div>
                <Separator />
                <InspectorSection title="Source">
                  <Property label="Family" value={selection.value.family} />
                  <Property label="File" value={selection.value.file} mono />
                </InspectorSection>
              </>
            )}

            {selection.kind === "token" && (
              <>
                <div className="p-4">
                  <Card className="overflow-hidden p-0">
                    <div className="h-24 border-b" style={{ background: selection.value.value }} />
                    <CardContent className="p-3">
                      <p className="truncate text-sm font-medium">{selection.value.name}</p>
                      <p className="font-mono text-xs text-muted-foreground">{selection.value.value}</p>
                    </CardContent>
                  </Card>
                </div>
                <Separator />
                <InspectorSection title="Token">
                  <Property label="Name" value={selection.value.name} mono />
                  <Property label="Value" value={selection.value.value} mono />
                  <Property label="Mode" value={selection.value.mode} />
                  <Property label="Source" value={selection.value.source} mono />
                </InspectorSection>
              </>
            )}

            {selection.kind === "asset" && (
              <>
                <div className="p-4">
                  <div className="grid min-h-32 place-items-center overflow-hidden rounded-lg border bg-muted/40">
                    {selection.value.previewUrl
                      ? <img className="max-h-52 w-full object-contain" src={selection.value.previewUrl} alt="" />
                      : <ImageIcon className="size-6 text-muted-foreground" />}
                  </div>
                </div>
                <Separator />
                <InspectorSection title="Asset">
                  <Property label="Name" value={selection.value.name} />
                  <Property label="Kind" value={selection.value.kind} />
                  <Property label="Size" value={formatBytes(selection.value.bytes)} />
                  <Property label="Path" value={selection.value.path} mono />
                </InspectorSection>
              </>
            )}

            {selection.kind === "route" && (
              <>
                <div className="flex items-center gap-3 p-4">
                  <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/40"><RouteIcon className="size-4" /></div>
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm font-medium">{selection.value.path}</p>
                    <p className="text-xs text-muted-foreground">Project route</p>
                  </div>
                </div>
                <Separator />
                <InspectorSection title="Route">
                  <Property label="Path" value={selection.value.path} mono />
                  <Property label="Kind" value={selection.value.kind} />
                  <Property label="File" value={selection.value.file} mono />
                </InspectorSection>
              </>
            )}

            {selection.kind === "server" && (
              <>
                <div className="flex items-center gap-3 p-4">
                  <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/40"><ServerIcon className="size-4" /></div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">Project dev server</p>
                    <p className="text-xs text-muted-foreground">Managed process</p>
                  </div>
                </div>
                <Separator />
                <InspectorSection title="Runtime">
                  <Property label="Status" value={session.phase} />
                  <Property label="Target" value={session.server.activeUrl ?? "Not running"} mono />
                  <Property label="Command" value={session.server.configured.command.join(" ")} mono />
                  <Property label="Adapter" value={session.adapter.name} />
                </InspectorSection>
              </>
            )}
          </ScrollArea>
        )}
      </div>
    </aside>
  );
}
