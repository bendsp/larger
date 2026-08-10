import {
  BlocksIcon,
  ComponentIcon,
  ImageIcon,
  MonitorPlayIcon,
  PaletteIcon,
  RouteIcon,
  ServerIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ProjectSummary, SessionPhase } from "@/contracts";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import type { Workspace } from "./types";

interface NavigationItem {
  id: Workspace;
  label: string;
  icon: LucideIcon;
  count?: number;
}

function phaseLabel(phase: SessionPhase): string {
  const labels: Record<SessionPhase, string> = {
    idle: "Offline",
    preparing: "Preparing",
    "starting-target": "Starting",
    "starting-adapter": "Attaching",
    ready: "Running",
    stopping: "Stopping",
    error: "Error",
  };
  return labels[phase];
}

export function StudioNavigation({
  project,
  phase,
  workspace,
  onWorkspaceChange,
}: {
  project: ProjectSummary | null;
  phase: SessionPhase;
  workspace: Workspace;
  onWorkspaceChange: (workspace: Workspace) => void;
}) {
  const library: NavigationItem[] = [
    { id: "components", label: "Components", icon: ComponentIcon, count: project?.components.length },
    { id: "design-system", label: "Design system", icon: PaletteIcon, count: project?.brand.tokens.length },
    { id: "assets", label: "Assets", icon: ImageIcon, count: project?.assets.length },
  ];
  const projectViews: NavigationItem[] = [
    { id: "canvas", label: "Canvas", icon: MonitorPlayIcon },
    { id: "routes", label: "Routes", icon: RouteIcon, count: project?.routes.length },
    { id: "servers", label: "Servers", icon: ServerIcon, count: phase === "idle" ? undefined : 1 },
  ];

  const renderGroup = (label: string, items: NavigationItem[]) => (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  isActive={workspace === item.id}
                  onClick={() => onWorkspaceChange(item.id)}
                >
                  <Icon data-icon="inline-start" />
                  <span>{item.label}</span>
                </SidebarMenuButton>
                {item.count !== undefined && <SidebarMenuBadge>{item.count}</SidebarMenuBadge>}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );

  return (
    <Sidebar collapsible="none" className="w-full border-r-0">
      <SidebarHeader className="p-3">
        <div className="flex items-center gap-2.5 px-1 py-1">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <BlocksIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{project?.name ?? "Reading project"}</p>
            <p className="truncate text-xs text-muted-foreground">
              {project ? `${project.framework} · ${project.git.branch}` : "Larger"}
            </p>
          </div>
        </div>
      </SidebarHeader>
      <Separator />
      <SidebarContent>
        {renderGroup("Library", library)}
        {renderGroup("Project", projectViews)}
      </SidebarContent>
      <SidebarFooter className="p-3">
        <div className="flex items-center rounded-lg border bg-background/50 px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={phase === "ready" ? "size-2 rounded-full bg-emerald-500" : "size-2 rounded-full bg-muted-foreground/40"} />
            {phaseLabel(phase)}
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
