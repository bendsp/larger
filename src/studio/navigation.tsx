import {
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
} from "@/components/ui/sidebar";
import type { Workspace } from "./types";
import { phaseLabel } from "./status";

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
