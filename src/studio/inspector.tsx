import {
  ComponentIcon,
  ImageIcon,
  MousePointer2Icon,
  RouteIcon,
  ServerIcon,
} from "lucide-react";
import type { SessionSnapshot } from "@/contracts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { cn } from "@/lib/utils";
import type { StudioSelection, Workspace } from "./types";
import { phaseLabel } from "./status";
import { formatBytes } from "./format";

function Property({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <Item role="listitem" size="xs" className="flex-col items-stretch gap-1 rounded-none px-0">
      <ItemContent>
        <ItemDescription>{label}</ItemDescription>
      </ItemContent>
      <ItemActions className="min-w-0 max-w-full justify-start">
        <span
          className={cn(
            "min-w-0 text-left text-xs",
            mono ? "overflow-x-auto whitespace-nowrap font-mono" : "break-words",
          )}
          title={value}
        >
          {value}
        </span>
      </ItemActions>
    </Item>
  );
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1 px-4 py-3">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ItemGroup className="gap-0">{children}</ItemGroup>
    </section>
  );
}

function SelectionSummary({
  icon: Icon,
  title,
  description,
  mono = false,
}: {
  icon: typeof ComponentIcon;
  title: string;
  description: string;
  mono?: boolean;
}) {
  return (
    <Item size="sm" className="rounded-none p-4">
      <ItemMedia variant="icon"><Icon /></ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className={cn("truncate", mono && "font-mono")}>{title}</ItemTitle>
        <ItemDescription>{description}</ItemDescription>
      </ItemContent>
    </Item>
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
      </header>
      <div className="min-h-0 flex-1">
        {!selection ? <EmptyInspector workspace={workspace} adapterName={session.adapter.name} /> : (
          <ScrollArea className="h-full">
            {selection.kind === "component" && (
              <>
                <SelectionSummary icon={ComponentIcon} title={selection.value.name} description="React component" />
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
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle className="truncate">{selection.value.name}</CardTitle>
                      <CardDescription className="font-mono">{selection.value.value}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="h-20 rounded-lg border" style={{ background: selection.value.value }} />
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
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle className="truncate">{selection.value.name}</CardTitle>
                      <CardDescription>{selection.value.kind}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="grid min-h-32 place-items-center overflow-hidden rounded-lg border bg-muted/40">
                        {selection.value.previewUrl
                          ? <img className="max-h-52 w-full object-contain" src={selection.value.previewUrl} alt="" />
                          : <ImageIcon className="text-muted-foreground" />}
                      </div>
                    </CardContent>
                  </Card>
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
                <SelectionSummary icon={RouteIcon} title={selection.value.path} description="Project route" mono />
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
                <SelectionSummary icon={ServerIcon} title="Project dev server" description="Managed process" />
                <Separator />
                <InspectorSection title="Runtime">
                  <Property label="Status" value={phaseLabel(session.phase)} />
                  <Property label="Target" value={session.server.active?.url ?? "Not running"} mono />
                  <Property
                    label={session.server.active ? "Command" : "Command template"}
                    value={(session.server.active?.command ?? session.server.configured.command).join(" ")}
                    mono
                  />
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
