import { app, BrowserWindow, WebContentsView, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const electronDirectory = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(electronDirectory, "..");
const developmentUrl = "http://127.0.0.1:4310";
const packagedStudioUrl = pathToFileURL(path.join(studioRoot, "dist", "index.html")).href;

let mainWindow = null;
let canvasView = null;
let canvasAttached = false;
let allowedCanvasOrigin = null;

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

function isTrustedStudioUrl(value) {
  try {
    const url = new URL(value);
    if (!app.isPackaged) return url.origin === new URL(developmentUrl).origin;
    url.hash = "";
    url.search = "";
    return url.href === packagedStudioUrl;
  } catch {
    return false;
  }
}

function assertTrustedStudioSender(event) {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isTrustedStudioUrl(senderUrl)) throw new Error("Rejected untrusted Electron IPC sender");
}

function ensureCanvasView() {
  if (canvasView) return canvasView;
  canvasView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: "larger-canvas",
    },
  });
  canvasView.setBackgroundColor("#f8f5ef");
  canvasView.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  canvasView.webContents.session.setPermissionCheckHandler(() => false);
  canvasView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  canvasView.webContents.on("will-navigate", (event, url) => {
    const nextOrigin = isLoopbackUrl(url) ? new URL(url).origin : null;
    if (!nextOrigin || (allowedCanvasOrigin && nextOrigin !== allowedCanvasOrigin)) {
      event.preventDefault();
    }
  });
  canvasView.webContents.on("did-navigate", (_event, url) => {
    mainWindow?.webContents.send("canvas:navigated", url);
  });
  canvasView.webContents.on("did-navigate-in-page", (_event, url) => {
    mainWindow?.webContents.send("canvas:navigated", url);
  });
  return canvasView;
}

function attachCanvas() {
  if (!mainWindow || canvasAttached) return;
  mainWindow.contentView.addChildView(ensureCanvasView());
  canvasAttached = true;
}

function hideCanvas() {
  if (!mainWindow || !canvasView || !canvasAttached) return;
  mainWindow.contentView.removeChildView(canvasView);
  canvasAttached = false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: "#11120f",
    title: "Larger",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(electronDirectory, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedStudioUrl(url)) event.preventDefault();
  });
  mainWindow.on("closed", () => {
    canvasView?.webContents.close();
    canvasView = null;
    mainWindow = null;
    canvasAttached = false;
  });

  if (app.isPackaged) {
    void mainWindow.loadURL(packagedStudioUrl);
  } else {
    void mainWindow.loadURL(developmentUrl);
  }
}

ipcMain.handle("canvas:load", async (_event, url) => {
  assertTrustedStudioSender(_event);
  if (!isLoopbackUrl(url)) throw new Error("Canvas only accepts loopback HTTP origins");
  const parsed = new URL(url);
  allowedCanvasOrigin = parsed.origin;
  attachCanvas();
  await ensureCanvasView().webContents.loadURL(url);
  return { ok: true };
});

ipcMain.handle("canvas:navigate", async (_event, url) => {
  assertTrustedStudioSender(_event);
  if (!isLoopbackUrl(url) || new URL(url).origin !== allowedCanvasOrigin) {
    throw new Error("Canvas navigation must stay on the active proxy origin");
  }
  attachCanvas();
  await ensureCanvasView().webContents.loadURL(url);
  return { ok: true };
});

ipcMain.on("canvas:bounds", (_event, bounds) => {
  try {
    assertTrustedStudioSender(_event);
  } catch {
    return;
  }
  if (!mainWindow || !canvasView || !canvasAttached) return;
  const windowBounds = mainWindow.getContentBounds();
  const numberOrZero = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };
  const x = Math.max(0, Math.min(windowBounds.width, Math.floor(numberOrZero(bounds?.x))));
  const y = Math.max(0, Math.min(windowBounds.height, Math.floor(numberOrZero(bounds?.y))));
  const safe = {
    x,
    y,
    width: Math.max(0, Math.min(windowBounds.width - x, Math.floor(numberOrZero(bounds?.width)))),
    height: Math.max(0, Math.min(windowBounds.height - y, Math.floor(numberOrZero(bounds?.height)))),
  };
  canvasView.setBounds(safe);
});

ipcMain.on("canvas:hide", (event) => {
  try {
    assertTrustedStudioSender(event);
    hideCanvas();
  } catch {
    // Ignore messages from navigated or destroyed renderers.
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
