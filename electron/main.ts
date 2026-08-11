import { app, BrowserWindow, dialog } from "electron";

import { createDesktopApplication, type DesktopApplication } from "./application.js";
import { DesktopHost } from "./lifecycle/desktop-host.js";
import {
  LaunchIntentRouter,
  launchIntentFromPath,
  parseLaunchIntent,
} from "./lifecycle/launch-intent-router.js";
import {
  applyPreReadyElectronPaths,
  prepareDesktopPathsSync,
} from "./lifecycle/desktop-paths.js";
import {
  createFatalStartupReporter,
  runDesktopStartup,
  runPreReadyStartup,
} from "./lifecycle/fatal-startup.js";
import {
  runWithShutdownDeadline,
  SHUTDOWN_DEADLINE_MS,
  shutdownExitAction,
} from "./lifecycle/shutdown-deadline.js";

const fatalStartup = createFatalStartupReporter({
  showErrorBox: (title, message) => dialog.showErrorBox(title, message),
  logPrivateCause: (message, cause) => console.error(message, cause),
  quit: () => {
    process.exitCode = 1;
    app.quit();
  },
});
const desktopPaths = runPreReadyStartup(() => {
  const paths = prepareDesktopPathsSync(app.getPath("userData"));
  applyPreReadyElectronPaths(app, paths);
  return paths;
}, fatalStartup);
const launchIntents = new LaunchIntentRouter();
let exitApproved = false;
let shutdownPromise: Promise<void> | null = null;

app.on("open-file", (event, projectPath) => {
  event.preventDefault();
  launchIntents.submit(launchIntentFromPath(projectPath, "open-file"));
});

const ownsInstanceLock = desktopPaths ? app.requestSingleInstanceLock() : false;

if (!desktopPaths || !ownsInstanceLock) {
  app.quit();
} else {
  const host = new DesktopHost<DesktopApplication>({
    createDesktop: () => createDesktopApplication({
      paths: desktopPaths,
      requestQuit: () => app.quit(),
    }),
    onPhase: (phase, cause) => {
      if (phase === "failed") console.error("Larger desktop startup failed", cause);
    },
  });

  const focusExistingWindow = (): void => {
    host.current()?.focusWindow();
  };

  launchIntents.submit(parseLaunchIntent(process.argv, "initial"));
  app.on("second-instance", (_event, argv) => {
    const intent = parseLaunchIntent(argv, "second-instance");
    launchIntents.submit(intent);
    if (!intent) focusExistingWindow();
  });

  void app.whenReady().then(async () => {
    const desktop = await runDesktopStartup(() => host.start(), fatalStartup);
    if (!desktop) return;
    launchIntents.attach(async (intent) => {
      if (intent.kind === "open-project") await desktop.openPath(intent.path);
    });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) desktop.createWindow();
    });
  });

  app.on("before-quit", (event) => {
    if (exitApproved) return;
    event.preventDefault();
    if (shutdownPromise) return;
    shutdownPromise = runWithShutdownDeadline(async () => {
      await launchIntents.stop();
      await host.stop();
    }, SHUTDOWN_DEADLINE_MS).then(() => {
      exitApproved = true;
      app.quit();
    }).catch((cause: unknown) => {
      console.error("Larger shutdown failed", cause);
      process.exitCode = 1;
      exitApproved = true;
      if (shutdownExitAction(cause) === "exit") app.exit(1);
      else app.quit();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
