import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { RuntimeWorkspaceProvider } from "./runtime-workspaces/provider.js";
import { ApplicationStateStore } from "./storage/application-state-store.js";
import { ProjectTrustStore } from "./projects/project-trust-store.js";
import { ProjectManager } from "./projects/project-manager.js";
import { registerProjectIpc } from "./ipc/project-ipc.js";
import { CanvasController } from "./canvas-controller.js";
import { WindowStateStore } from "./storage/window-state-store.js";

const DEVELOPMENT_URL = "http://127.0.0.1:4310";

export interface DesktopApplication {
  readonly projectManager: ProjectManager;
  getWindow(): BrowserWindow | null;
  createWindow(): BrowserWindow;
  dispose(): Promise<void>;
}

function trustedStudioUrl(value: string, packagedUrl: string): boolean {
  try {
    const url = new URL(value);
    if (!app.isPackaged) return url.origin === new URL(DEVELOPMENT_URL).origin;
    url.hash = "";
    url.search = "";
    return url.href === packagedUrl;
  } catch {
    return false;
  }
}

export async function createDesktopApplication(): Promise<DesktopApplication> {
  const applicationRoot = app.getAppPath();
  const packagedUrl = pathToFileURL(path.join(applicationRoot, "dist", "index.html")).href;
  const userData = app.getPath("userData");
  const applicationState = new ApplicationStateStore(path.join(userData, "state", "application.json"));
  const trust = new ProjectTrustStore(path.join(userData, "state", "project-trust.json"));
  const windowStateStore = new WindowStateStore(path.join(userData, "state", "window.json"));
  let storedWindowState = (await windowStateStore.read()).value;
  let windowStateWrite: Promise<void> = Promise.resolve();
  const projectManager = new ProjectManager({
    applicationState,
    trust,
    createWorkspace: (identity) => new RuntimeWorkspaceProvider({
      userDataPath: userData,
      localInstanceKey: identity.instanceKey,
    }),
  });

  let mainWindow: BrowserWindow | null = null;
  const assertTrustedSender = (event: IpcMainInvokeEvent | IpcMainEvent): void => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
      throw new Error("Rejected project IPC from an unknown renderer");
    }
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    if (!trustedStudioUrl(senderUrl, packagedUrl)) throw new Error("Rejected untrusted Electron IPC sender");
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
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (!trustedStudioUrl(url, packagedUrl)) event.preventDefault();
    });
    mainWindow.on("closed", () => {
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
    void mainWindow.loadURL(app.isPackaged ? packagedUrl : DEVELOPMENT_URL);
    return mainWindow;
  };

  const disposeProjectIpc = registerProjectIpc({
    ipcMain,
    dialog,
    manager: projectManager,
    getWindow: () => mainWindow,
    assertTrustedSender,
  });
  const canvasController = new CanvasController({
    ipcMain,
    shell,
    manager: projectManager,
    getWindow: () => mainWindow,
    assertTrustedSender,
  });

  createWindow();
  await projectManager.bootstrap();

  return {
    projectManager,
    getWindow: () => mainWindow,
    createWindow,
    async dispose() {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const bounds = mainWindow.getNormalBounds();
        storedWindowState = { schemaVersion: 1, bounds, maximized: mainWindow.isMaximized() };
        windowStateWrite = windowStateStore.write(storedWindowState);
      }
      await windowStateWrite;
      canvasController.dispose();
      disposeProjectIpc();
      projectManager.dispose();
      mainWindow?.destroy();
      mainWindow = null;
    },
  };
}
