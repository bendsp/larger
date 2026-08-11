import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { CanvasController } from "../../electron/canvas-controller.js";
import { ChangeService } from "../../electron/changes/change-service.js";
import { registerChangeIpc } from "../../electron/ipc/change-ipc.js";
import { registerProjectIpc } from "../../electron/ipc/project-ipc.js";
import { registerRuntimeIpc } from "../../electron/ipc/runtime-ipc.js";
import { ProjectActivityCoordinator } from "../../electron/projects/project-activity.js";
import { ProjectManager } from "../../electron/projects/project-manager.js";
import { ProjectTrustStore } from "../../electron/projects/project-trust-store.js";
import { RuntimeWorkspaceRegistry } from "../../electron/runtime-workspaces/registry.js";
import { DependencyService } from "../../electron/runtime-workspaces/dependencies/service.js";
import { SupervisedDependencyCommandRunner } from "../../electron/runtime-workspaces/dependencies/supervised-command-runner.js";
import { DependencyServiceRuntimePreparer } from "../../electron/runtime/dependency-preparer.js";
import {
  ProcessEnvironmentSecretProvider,
  RuntimeEnvironmentBuilder,
  currentProcessEnvironmentSource,
} from "../../electron/runtime/environment.js";
import { StaticEditorAdapterRegistry } from "../../electron/runtime/editor-adapter.js";
import { ReactRewriteEditorAdapter } from "../../electron/runtime/editors/react-rewrite/index.js";
import { FetchReadinessProbe, LoopbackPortAllocator } from "../../electron/runtime/network.js";
import { FileOwnershipStore } from "../../electron/runtime/ownership-store.js";
import { DarwinProcessSupervisor } from "../../electron/runtime/process-supervisor.js";
import { createDefaultRuntimeAdapterRegistry } from "../../electron/runtime/runtime-adapter.js";
import { RuntimeService } from "../../electron/runtime/runtime-service.js";
import { ApplicationStateStore } from "../../electron/storage/application-state-store.js";

const userData = process.env.LARGER_ELECTRON_TEST_USER_DATA;
const preload = process.env.LARGER_ELECTRON_TEST_PRELOAD;
const projectPath = process.env.LARGER_ELECTRON_TEST_PROJECT;
const projectPaths = process.env.LARGER_ELECTRON_TEST_PROJECTS
  ? JSON.parse(process.env.LARGER_ELECTRON_TEST_PROJECTS) as string[]
  : projectPath ? [projectPath] : [];
const rendererUrl = process.env.LARGER_ELECTRON_TEST_RENDERER_URL;
const reactRewriteCliPath = process.env.LARGER_ELECTRON_TEST_REACT_REWRITE_CLI;
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
  const dependencyServices = new Map<string, Promise<DependencyService>>();
  const processEnvironment = currentProcessEnvironmentSource();
  const processSupervisor = new DarwinProcessSupervisor({
    ownership: new FileOwnershipStore(path.join(userData, "runtime", "ownership")),
  });
  const runtime = new RuntimeService({
    projects: {
      current(generation) {
        const active = manager.snapshot().active;
        if (!active || active.generation !== generation) return undefined;
        return {
          identity: active.identity,
          generation: active.generation,
          trusted: active.trust === "trusted",
          profiles: active.manifest.runtimeProfiles,
        };
      },
      adoptWorkspace(generation, instanceKey, workspace) {
        return manager.adoptPublishedWorkspace(generation, instanceKey, workspace);
      },
    },
    workspaces,
    dependencies: new DependencyServiceRuntimePreparer({
      for(project) {
        const key = project.identity.instanceKey;
        let service = dependencyServices.get(key);
        if (!service) {
          service = DependencyService.open({
            userDataPath: userData,
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
    environment: new RuntimeEnvironmentBuilder(
      processEnvironment,
      new ProcessEnvironmentSecretProvider(processEnvironment),
    ),
    runtimeAdapters: createDefaultRuntimeAdapterRegistry(),
    editorAdapters: new StaticEditorAdapterRegistry(
      reactRewriteCliPath ? [new ReactRewriteEditorAdapter({ cliPath: reactRewriteCliPath })] : [],
    ),
    supervisor: processSupervisor,
    ports: new LoopbackPortAllocator(),
    readiness: new FetchReadinessProbe(),
  });
  activity.registerRuntimeParticipant(runtime);
  await runtime.recover();
  await manager.bootstrap();
  const window = new BrowserWindow({
    show: process.env.LARGER_ELECTRON_TEST_SHOW === "true",
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
  registerRuntimeIpc({ ipcMain, service: runtime, getWindow: () => window, assertTrustedSender });
  new CanvasController({
    ipcMain,
    manager,
    runtime,
    getWindow: () => window,
    assertTrustedSender,
  });
  await window.loadURL(rendererUrl ?? "data:text/html,<main id='ready'>Larger test harness</main>");
});
