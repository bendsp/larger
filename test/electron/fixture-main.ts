import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { ChangeService } from "../../electron/changes/change-service.js";
import { registerChangeIpc } from "../../electron/ipc/change-ipc.js";
import { registerProjectIpc } from "../../electron/ipc/project-ipc.js";
import { ProjectActivityCoordinator } from "../../electron/projects/project-activity.js";
import { ProjectManager } from "../../electron/projects/project-manager.js";
import { ProjectTrustStore } from "../../electron/projects/project-trust-store.js";
import { RuntimeWorkspaceRegistry } from "../../electron/runtime-workspaces/registry.js";
import { ApplicationStateStore } from "../../electron/storage/application-state-store.js";

const userData = process.env.LARGER_ELECTRON_TEST_USER_DATA;
const preload = process.env.LARGER_ELECTRON_TEST_PRELOAD;
const projectPath = process.env.LARGER_ELECTRON_TEST_PROJECT;
const projectPaths = process.env.LARGER_ELECTRON_TEST_PROJECTS
  ? JSON.parse(process.env.LARGER_ELECTRON_TEST_PROJECTS) as string[]
  : projectPath ? [projectPath] : [];
const rendererUrl = process.env.LARGER_ELECTRON_TEST_RENDERER_URL;
const cancelFirst = process.env.LARGER_ELECTRON_TEST_CANCEL_FIRST !== "false";
if (!userData || !preload || projectPaths.length === 0) throw new Error("Electron test harness paths are required");
app.setPath("userData", userData);

void app.whenReady().then(async () => {
  const workspaces = new RuntimeWorkspaceRegistry({ userDataPath: userData });
  const activity = new ProjectActivityCoordinator();
  const manager = new ProjectManager({
    applicationState: new ApplicationStateStore(path.join(userData, "application.json")),
    trust: new ProjectTrustStore(path.join(userData, "trust.json")),
    createWorkspace: (identity) => workspaces.for(identity),
    switchGuard: activity,
  });
  const changes = new ChangeService({ userDataPath: userData, projects: manager, workspaces, activity });
  await manager.bootstrap();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  let pickerCount = 0;
  const assertTrustedSender = (event: Parameters<Parameters<typeof registerProjectIpc>[0]["assertTrustedSender"]>[0]) => {
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    const trustedUrl = rendererUrl ? senderUrl.startsWith(rendererUrl) : senderUrl.startsWith("data:text/html");
    if (event.sender.id !== window.webContents.id || !trustedUrl) {
      throw new Error("Rejected untrusted test renderer");
    }
  };
  registerProjectIpc({
    ipcMain,
    manager,
    getWindow: () => window,
    assertTrustedSender,
    dialog: {
      showOpenDialog: async () => {
        pickerCount += 1;
        if (cancelFirst && pickerCount === 1) return { canceled: true, filePaths: [] };
        const projectIndex = cancelFirst ? pickerCount - 2 : pickerCount - 1;
        const selected = projectPaths[Math.min(projectIndex, projectPaths.length - 1)]!;
        return { canceled: false, filePaths: [selected] };
      },
    },
  });
  registerChangeIpc({ ipcMain, service: changes, getWindow: () => window, assertTrustedSender });
  await window.loadURL(rendererUrl ?? "data:text/html,<main id='ready'>Larger test harness</main>");
});
