import {
  CircleIcon,
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
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import type { Workspace } from "./types";
import { phaseLabel } from "./status";
import { cn } from "@/lib/utils";

interface NavigationItem {
  id: Workspace;
  label: string;
  icon: LucideIcon;
  count?: number | string;
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
  const { isMobile, setOpenMobile } = useSidebar();
  const library: NavigationItem[] = [
    { id: "components", label: "Components", icon: ComponentIcon, count: project ? `${project.components.length}${project.truncated.files ? "+" : ""}` : undefined },
    { id: "design-system", label: "Design system", icon: PaletteIcon, count: project ? `${project.brand.tokens.length}${project.truncated.css ? "+" : ""}` : undefined },
    { id: "assets", label: "Assets", icon: ImageIcon, count: project ? `${project.assets.length}${project.truncated.assets ? "+" : ""}` : undefined },
  ];
  const projectViews: NavigationItem[] = [
    { id: "canvas", label: "Canvas", icon: MonitorPlayIcon },
    { id: "routes", label: "Routes", icon: RouteIcon, count: project ? `${project.routes.length}${project.truncated.files ? "+" : ""}` : undefined },
    { id: "servers", label: "Servers", icon: ServerIcon },
  ];
  const selectWorkspace = (next: Workspace) => {
    onWorkspaceChange(next);
    if (isMobile) setOpenMobile(false);
  };
  const isTransitioning = !["idle", "ready", "error"].includes(phase);

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
                  aria-current={workspace === item.id ? "page" : undefined}
                  isActive={workspace === item.id}
                  onClick={() => selectWorkspace(item.id)}
                  tooltip={item.label}
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
    <Sidebar collapsible="icon" className="top-12! bottom-auto! h-[calc(100svh-3rem)]!">
      <SidebarContent>
        {renderGroup("Library", library)}
        {renderGroup("Project", projectViews)}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<div role="status" tabIndex={0} aria-label={`Server status: ${phaseLabel(phase)}`} />}
              tooltip={phaseLabel(phase)}
            >
              <CircleIcon
                className={cn(
                  phase === "ready"
                    ? "fill-primary text-primary"
                    : phase === "error"
                      ? "fill-destructive text-destructive"
                      : isTransitioning
                        ? "fill-foreground text-foreground"
                        : "fill-muted-foreground/40 text-muted-foreground/40",
                )}
              />
              <span className="group-data-[collapsible=icon]:hidden">{phaseLabel(phase)}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
