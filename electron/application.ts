import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  WebContentsView,
  type Dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
} from "electron";
import { RuntimeWorkspaceRegistry } from "./runtime-workspaces/registry.js";
import { ApplicationStateStore } from "./storage/application-state-store.js";
import { ProjectTrustStore } from "./projects/project-trust-store.js";
import { ProjectManager } from "./projects/project-manager.js";
import { ProjectActivityCoordinator } from "./projects/project-activity.js";
import { registerProjectIpc } from "./ipc/project-ipc.js";
import { registerChangeIpc } from "./ipc/change-ipc.js";
import { ChangeService } from "./changes/change-service.js";
import { CanvasController } from "./canvas-controller.js";
import { WindowStateStore } from "./storage/window-state-store.js";
import { DependencyService } from "./runtime-workspaces/dependencies/service.js";
import { SupervisedDependencyCommandRunner } from "./runtime-workspaces/dependencies/supervised-command-runner.js";
import { DependencyServiceRuntimePreparer } from "./runtime/dependency-preparer.js";
import {
  ProcessEnvironmentSecretProvider,
  RuntimeEnvironmentBuilder,
  currentProcessEnvironmentSource,
} from "./runtime/environment.js";
import { StaticEditorAdapterRegistry } from "./runtime/editor-adapter.js";
import { ReactRewriteEditorAdapter } from "./runtime/editors/react-rewrite/index.js";
import { FetchReadinessProbe, LoopbackPortAllocator, LoopbackRuntimeDiscoveryProvider } from "./runtime/network.js";
import { FileOwnershipStore } from "./runtime/ownership-store.js";
import { DarwinProcessSupervisor } from "./runtime/process-supervisor.js";
import { createDefaultRuntimeAdapterRegistry } from "./runtime/runtime-adapter.js";
import { RuntimeService } from "./runtime/runtime-service.js";
import { registerRuntimeIpc } from "./ipc/runtime-ipc.js";
import { registerApplicationIpc } from "./ipc/application-ipc.js";
import { DesktopIpcRouter, type DesktopIpcOperationContext } from "./ipc/desktop-ipc-router.js";
import { RendererSessionRegistry } from "./ipc/renderer-session-registry.js";
import { ApplicationService } from "./lifecycle/application-service.js";
import { ApplicationMenuController } from "./lifecycle/application-menu.js";
import { prepareDesktopPaths, type DesktopPaths } from "./lifecycle/desktop-paths.js";
import { createLifecycleLogger } from "./lifecycle/lifecycle-logger.js";
import { DesktopRecoveryCoordinator } from "./lifecycle/recovery-coordinator.js";
import { createRendererFailureReporter } from "./lifecycle/renderer-failure.js";
import { denyStudioPermissions, trustedStudioUrl } from "./studio-security.js";
import type { ProjectOperationResult } from "../src/project-ipc.js";

const DEVELOPMENT_URL = "http://127.0.0.1:4310";

export interface DesktopApplication {
  readonly projectManager: ProjectManager;
  getWindow(): BrowserWindow | null;
  createWindow(): BrowserWindow;
  focusWindow(): void;
  openPath(projectPath: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface DesktopApplicationOptions {
  readonly bootId?: string;
  readonly paths?: DesktopPaths;
  readonly requestQuit?: () => void;
}

export async function createDesktopApplication(options: DesktopApplicationOptions = {}): Promise<DesktopApplication> {
  const applicationRoot = app.getAppPath();
  const packagedUrl = pathToFileURL(path.join(applicationRoot, "dist", "index.html")).href;
  const userData = app.getPath("userData");
  const paths = options.paths ?? await prepareDesktopPaths(userData);
  const logger = await createLifecycleLogger({ logsRoot: paths.logsRoot });
  const applicationState = new ApplicationStateStore(path.join(paths.stateRoot, "application.json"));
  const trust = new ProjectTrustStore(path.join(paths.stateRoot, "project-trust.json"));
  const windowStateStore = new WindowStateStore(path.join(paths.stateRoot, "window.json"));
  const workspaces = new RuntimeWorkspaceRegistry({ userDataPath: paths.runtimeWorkspacesRoot });
  const projectActivity = new ProjectActivityCoordinator();
  let storedWindowState = (await windowStateStore.read()).value;
  let windowStateWrite: Promise<void> = Promise.resolve();
  const projectManager = new ProjectManager({
    applicationState,
    trust,
    createWorkspace: (identity) => workspaces.for(identity),
    switchGuard: projectActivity,
  });
  const changeService = new ChangeService({
    userDataPath: paths.runtimeWorkspacesRoot,
    projects: projectManager,
    workspaces,
    activity: projectActivity,
  });
  const dependencyServices = new Map<string, Promise<DependencyService>>();
  const processEnvironment = currentProcessEnvironmentSource();
  const processSupervisor = new DarwinProcessSupervisor({
    ownership: new FileOwnershipStore(paths.processOwnershipRoot),
  });
  const runtimeService = new RuntimeService({
    projects: {
      current(generation) {
        const snapshot = projectManager.snapshot();
        const active = snapshot.active;
        if (snapshot.transition || !active || active.generation !== generation) return undefined;
        return {
          identity: active.identity,
          generation: active.generation,
          trusted: active.trust === "trusted",
          profiles: active.manifest.runtimeProfiles,
        };
      },
      adoptWorkspace(generation, instanceKey, workspace) {
        return projectManager.adoptPublishedWorkspace(generation, instanceKey, workspace);
      },
    },
    workspaces,
    dependencies: new DependencyServiceRuntimePreparer({
      for(project) {
        const key = project.identity.instanceKey;
        let service = dependencyServices.get(key);
        if (!service) {
          service = DependencyService.open({
            userDataPath: paths.runtimeWorkspacesRoot,
            localInstanceKey: key,
            commandRunner: new SupervisedDependencyCommandRunner({
              supervisor: processSupervisor,
              projectInstanceKey: key,
            }),
          });
          dependencyServices.set(key, service);
        }
        return service;
      },
    }),
    environment: new RuntimeEnvironmentBuilder(processEnvironment, new ProcessEnvironmentSecretProvider(processEnvironment)),
    runtimeAdapters: createDefaultRuntimeAdapterRegistry(),
    editorAdapters: new StaticEditorAdapterRegistry([new ReactRewriteEditorAdapter()]),
    supervisor: processSupervisor,
    ports: new LoopbackPortAllocator(),
    readiness: new FetchReadinessProbe(),
    discovery: new LoopbackRuntimeDiscoveryProvider(),
  });
  const unregisterRuntimeActivity = projectActivity.registerRuntimeParticipant(runtimeService);
  const desktopRecovery = new DesktopRecoveryCoordinator({ userDataPath: paths.userDataRoot });
  const bootId = options.bootId ?? randomUUID();
  let applicationService!: ApplicationService;
  const recoverServices = async (): Promise<void> => {
    applicationService.startRecovery();
    try {
      await logger.write({ level: "info", event: "desktop.recovery.started", message: "Desktop recovery started." });
      const runtimeRecovery = await runtimeService.recover();
      const recoveryReport = await desktopRecovery.recover();
      if (recoveryReport.status === "incomplete") {
        const recoveryProblem = {
          code: "unavailable" as const,
          message: "Some recovery data needs inspection before workspace cleanup is complete.",
          retryable: true,
        };
        applicationService.setService("workspaces", "degraded", recoveryProblem);
        applicationService.setService("changes", "degraded", recoveryProblem);
        await logger.write({
          level: "warning",
          event: "desktop.recovery.preserved",
          message: "Desktop recovery preserved entries that require inspection.",
          details: recoveryReport,
        });
      } else {
        applicationService.setService("workspaces", "ready");
        applicationService.setService("changes", "ready");
      }
      if (runtimeRecovery.snapshot.problem) {
        await logger.write({
          level: "warning",
          event: "desktop.runtime.recovery-degraded",
          message: runtimeRecovery.snapshot.problem.message,
          details: { code: runtimeRecovery.snapshot.problem.code },
        });
        applicationService.setService("runtime", "degraded", {
          code: "unavailable",
          message: "Managed runtime recovery needs attention before runtimes can start.",
          retryable: runtimeRecovery.snapshot.problem.recoverable,
        });
        applicationService.setService("editor", "degraded", {
          code: "unavailable",
          message: "The editor will remain unavailable until runtime recovery succeeds.",
          retryable: true,
        });
      } else {
        applicationService.setService("runtime", "ready");
        applicationService.setService("editor", "ready");
      }
      await projectManager.bootstrap();
      applicationService.setService("projects", "ready");
      applicationService.markReady();
      await logger.write({ level: "info", event: "desktop.recovery.completed", message: "Desktop recovery completed." });
    } catch (cause) {
      applicationService.markUnavailable(cause);
      await logger.write({
        level: "error",
        event: "desktop.recovery.failed",
        message: cause instanceof Error ? cause.message : "Desktop recovery failed.",
      }).catch(() => undefined);
      throw cause;
    }
  };
  applicationService = new ApplicationService({
    bootId,
    retry: recoverServices,
    quit: () => (options.requestQuit ?? (() => app.quit()))(),
  });

  let mainWindow: BrowserWindow | null = null;
  const assertTrustedSender = (event: IpcMainInvokeEvent | IpcMainEvent): void => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
      throw new Error("Rejected project IPC from an unknown renderer");
    }
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Rejected Electron IPC from a subframe");
    }
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    if (!trustedStudioUrl(senderUrl, {
      developmentUrl: DEVELOPMENT_URL,
      packagedUrl,
      packaged: app.isPackaged,
    })) throw new Error("Rejected untrusted Electron IPC sender");
  };
  const rendererSessions = new RendererSessionRegistry(bootId);
  const desktopRouter = new DesktopIpcRouter({
    ipcMain,
    sessions: rendererSessions,
    assertTrustedSender,
    onContractViolation: (error) => {
      applicationService.markUnavailable(error);
      void logger.write({
        level: "error",
        event: "desktop.contract.failed",
        message: error.message,
        details: { code: error.code },
      });
    },
    onUnexpectedError: (cause, context) => {
      void logger.write({
        level: "error",
        event: "desktop.operation.failed",
        message: cause instanceof Error ? cause.message : "Desktop operation failed.",
        details: context,
      });
    },
  });
  let canvasController: CanvasController | null = null;
  const rendererFailure = createRendererFailureReporter({
    log: async (cause) => {
      applicationService.markUnavailable(new Error("The Larger interface could not be loaded."));
      await logger.write({
        level: "error",
        event: "desktop.renderer.failed",
        message: cause instanceof Error ? cause.message : "The renderer failed.",
      }).catch(() => undefined);
    },
    prompt: async () => {
      const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const message: MessageBoxOptions = {
        type: "error",
        title: "Larger couldn’t load",
        message: "The Larger interface stopped responding.",
        detail: "Try loading it again, or quit and reopen Larger.",
        buttons: ["Try again", "Quit"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const result = owner
        ? await dialog.showMessageBox(owner, message)
        : await dialog.showMessageBox(message);
      return result.response === 0 ? "retry" : "quit";
    },
    retry: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
      else createWindow();
    },
    quit: () => (options.requestQuit ?? (() => app.quit()))(),
  });
  let projectPicker: Promise<Awaited<ReturnType<Dialog["showOpenDialog"]>>> | null = null;
  const pickAndOpenProject = async (context?: DesktopIpcOperationContext): Promise<ProjectOperationResult> => {
    if (projectPicker) throw new Error("A project folder picker is already open");
    const owner = createWindow();
    if (owner.isMinimized()) owner.restore();
    owner.show();
    owner.focus();
    projectPicker = dialog.showOpenDialog(owner, {
      title: "Open project",
      buttonLabel: "Open project",
      properties: ["openDirectory", "createDirectory"],
    });
    try {
      const result = await projectPicker;
      context?.assertCurrent();
      if (result.canceled || result.filePaths.length === 0) {
        return { status: "cancelled", snapshot: projectManager.snapshot() };
      }
      return projectManager.openPath(result.filePaths[0]!, undefined, { signal: context?.signal });
    } finally {
      projectPicker = null;
    }
  };

  const createWindow = (): BrowserWindow => {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
    const display = screen.getDisplayMatching(storedWindowState.bounds).workArea;
    const width = Math.min(storedWindowState.bounds.width, display.width);
    const height = Math.min(storedWindowState.bounds.height, display.height);
    const x = Math.max(display.x, Math.min(storedWindowState.bounds.x, display.x + display.width - width));
    const y = Math.max(display.y, Math.min(storedWindowState.bounds.y, display.y + display.height - height));
    mainWindow = new BrowserWindow({
      x,
      y,
      width,
      height,
      minWidth: 1080,
      minHeight: 680,
      backgroundColor: "#11120f",
      title: "Larger",
      ...(process.platform === "darwin" ? {
        titleBarStyle: "hiddenInset" as const,
        trafficLightPosition: { x: 16, y: 18 },
      } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    denyStudioPermissions(mainWindow.webContents.session);
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (!trustedStudioUrl(url, {
        developmentUrl: DEVELOPMENT_URL,
        packagedUrl,
        packaged: app.isPackaged,
      })) event.preventDefault();
    });
    mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      void rendererFailure
        .report(new Error(`Renderer load failed (${errorCode}) for ${validatedUrl}: ${errorDescription}`))
        .catch(() => undefined);
    });
    mainWindow.webContents.on("render-process-gone", (_event, details) => {
      void rendererFailure
        .report(new Error(`Renderer process exited: ${details.reason}`))
        .catch(() => undefined);
    });
    mainWindow.on("closed", () => {
      canvasController?.detachWindow(mainWindow ?? undefined);
      mainWindow = null;
    });
    mainWindow.on("close", () => {
      if (!mainWindow) return;
      const bounds = mainWindow.getNormalBounds();
      storedWindowState = {
        schemaVersion: 1,
        bounds,
        maximized: mainWindow.isMaximized(),
      };
      windowStateWrite = windowStateStore.write(storedWindowState);
      void windowStateWrite.catch((cause: unknown) => console.error("Failed to persist window state", cause));
    });
    if (storedWindowState.maximized) mainWindow.maximize();
    void mainWindow.loadURL(app.isPackaged ? packagedUrl : DEVELOPMENT_URL)
      .catch((cause: unknown) => rendererFailure.report(cause))
      .catch(() => undefined);
    return mainWindow;
  };

  const disposeApplicationIpc = registerApplicationIpc({
    router: desktopRouter,
    service: applicationService,
    getWindow: () => mainWindow,
  });
  const disposeProjectIpc = registerProjectIpc({
    router: desktopRouter,
    dialog,
    manager: projectManager,
    getWindow: () => mainWindow,
    pickAndOpen: (context) => pickAndOpenProject(context),
    openRecent: (instanceKey, context) => projectManager.openRecent(instanceKey, { signal: context.signal }),
    removeRecent: (instanceKey, context) => projectManager.removeRecent(instanceKey, { signal: context.signal }),
  });
  const disposeChangeIpc = registerChangeIpc({
    router: desktopRouter,
    service: changeService,
    getWindow: () => mainWindow,
  });
  const disposeRuntimeIpc = registerRuntimeIpc({
    router: desktopRouter,
    service: runtimeService,
    getWindow: () => mainWindow,
  });
  canvasController = new CanvasController({
    router: desktopRouter,
    manager: projectManager,
    runtime: runtimeService,
    getWindow: () => mainWindow,
    createView: (viewOptions) => new WebContentsView(viewOptions),
  });
  const menuController = new ApplicationMenuController({
    adapter: {
      install(template) {
        Menu.setApplicationMenu(Menu.buildFromTemplate([...template]));
      },
    },
    commands: {
      openProject: async () => { await pickAndOpenProject(); },
      openRecent: async (instanceKey) => {
        await projectManager.openRecent(instanceKey);
        const window = createWindow();
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      },
      closeProject: async (generation) => { await projectManager.close(generation); },
      onError: (cause) => {
        void logger.write({
          level: "error",
          event: "desktop.menu-command.failed",
          message: cause instanceof Error ? cause.message : "Native application command failed.",
        }).catch(() => undefined);
        dialog.showErrorBox(
          "Couldn’t complete that command",
          "Larger couldn’t complete that command. Review the current project state and try again.",
        );
      },
    },
    development: !app.isPackaged,
  });
  const disposeMenuSubscription = projectManager.subscribe((snapshot) => menuController.refresh(snapshot));
  menuController.refresh(projectManager.snapshot());

  createWindow();
  await recoverServices().catch(() => undefined);

  return {
    projectManager,
    getWindow: () => mainWindow,
    createWindow,
    focusWindow() {
      const window = createWindow();
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    },
    async openPath(projectPath) {
      await projectManager.openPath(projectPath);
      const window = createWindow();
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    },
    async dispose() {
      applicationService.beginShutdown();
      const failures: unknown[] = [];
      const cleanup = async (operation: () => Promise<void> | void): Promise<void> => {
        try {
          await operation();
        } catch (cause) {
          failures.push(cause);
        }
      };
      await cleanup(() => logger.write({
        level: "info",
        event: "desktop.shutdown.started",
        message: "Desktop shutdown started.",
      }));
      if (mainWindow && !mainWindow.isDestroyed()) {
        const bounds = mainWindow.getNormalBounds();
        storedWindowState = { schemaVersion: 1, bounds, maximized: mainWindow.isMaximized() };
        windowStateWrite = windowStateStore.write(storedWindowState);
      }
      await cleanup(() => windowStateWrite);
      await cleanup(() => canvasController?.dispose());
      await cleanup(() => disposeMenuSubscription());
      await cleanup(() => disposeRuntimeIpc());
      await cleanup(() => disposeChangeIpc());
      await cleanup(() => disposeProjectIpc());
      await cleanup(() => disposeApplicationIpc());
      await cleanup(() => desktopRouter.dispose());
      await cleanup(() => changeService.dispose());
      await cleanup(() => runtimeService.dispose());
      await cleanup(() => unregisterRuntimeActivity());
      await cleanup(() => projectManager.dispose());
      await cleanup(() => dependencyServices.clear());
      await cleanup(() => workspaces.clear());
      await cleanup(() => Menu.setApplicationMenu(null));
      await cleanup(() => mainWindow?.destroy());
      mainWindow = null;
      await cleanup(() => logger.write({
        level: failures.length === 0 ? "info" : "error",
        event: failures.length === 0 ? "desktop.shutdown.completed" : "desktop.shutdown.incomplete",
        message: failures.length === 0
          ? "Desktop shutdown completed."
          : "Desktop shutdown completed with cleanup failures.",
        details: failures.length === 0 ? undefined : { failures: failures.length },
      }));
      await cleanup(() => logger.close());
      if (failures.length > 0) throw new AggregateError(failures, "Desktop shutdown did not complete cleanly");
    },
  };
}
