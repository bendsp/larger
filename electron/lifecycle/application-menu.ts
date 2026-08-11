import type { MenuItemConstructorOptions } from "electron";
import type { ProjectLifecycleSnapshot } from "../../src/project-ipc.js";

export interface ApplicationMenuCommands {
  readonly openProject: () => Promise<void> | void;
  readonly openRecent: (instanceKey: string) => Promise<void> | void;
  readonly closeProject: (generation: number) => Promise<void> | void;
  readonly onError?: (cause: unknown) => void;
}

export interface ApplicationMenuAdapter {
  install(template: readonly MenuItemConstructorOptions[]): void;
}

function invoke(operation: () => Promise<void> | void, onError?: (cause: unknown) => void): void {
  void Promise.resolve().then(operation).catch((cause: unknown) => {
    if (onError) onError(cause);
    else console.error("Native application command failed", cause);
  });
}

export function createApplicationMenuTemplate(
  snapshot: ProjectLifecycleSnapshot,
  commands: ApplicationMenuCommands,
  platform = process.platform,
  development = false,
): MenuItemConstructorOptions[] {
  const recentItems: MenuItemConstructorOptions[] = snapshot.recentProjects.length > 0
    ? snapshot.recentProjects.map((project) => ({
      label: project.displayName,
      sublabel: project.canonicalPath,
      click: () => invoke(() => commands.openRecent(project.instanceKey), commands.onError),
    }))
    : [{ label: "No Recent Projects", enabled: false }];
  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      {
        label: "Open Project…",
        accelerator: "CmdOrCtrl+O",
        click: () => invoke(commands.openProject, commands.onError),
      },
      { label: "Open Recent", submenu: recentItems },
      { type: "separator" },
      {
        label: "Close Project",
        accelerator: "CmdOrCtrl+Shift+W",
        enabled: Boolean(snapshot.active) && !snapshot.transition,
        click: () => {
          const active = snapshot.active;
          if (active) invoke(() => commands.closeProject(active.generation), commands.onError);
        },
      },
      ...(platform === "darwin" ? [] : [{ type: "separator" as const }, { role: "quit" as const }]),
    ],
  };
  return [
    ...(platform === "darwin" ? [{
      label: "Larger",
      submenu: [
        { role: "about" as const },
        { type: "separator" as const },
        { role: "hide" as const },
        { role: "hideOthers" as const },
        { role: "unhide" as const },
        { type: "separator" as const },
        { role: "quit" as const },
      ],
    }] : []),
    fileMenu,
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    {
      label: "View",
      submenu: [
        ...(development ? [
          { role: "reload" as const },
          { role: "toggleDevTools" as const },
          { type: "separator" as const },
        ] : []),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, ...(platform === "darwin" ? [{ type: "separator" as const }, { role: "front" as const }] : [{ role: "close" as const }])] },
  ];
}

export class ApplicationMenuController {
  private readonly adapter: ApplicationMenuAdapter;
  private readonly commands: ApplicationMenuCommands;
  private readonly platform: NodeJS.Platform;
  private readonly development: boolean;

  constructor(options: {
    readonly adapter: ApplicationMenuAdapter;
    readonly commands: ApplicationMenuCommands;
    readonly platform?: NodeJS.Platform;
    readonly development?: boolean;
  }) {
    this.adapter = options.adapter;
    this.commands = options.commands;
    this.platform = options.platform ?? process.platform;
    this.development = options.development ?? false;
  }

  refresh(snapshot: ProjectLifecycleSnapshot): void {
    this.adapter.install(createApplicationMenuTemplate(snapshot, this.commands, this.platform, this.development));
  }
}
