import { app, BrowserWindow } from "electron";
import { createDesktopApplication, type DesktopApplication } from "./application.js";

let desktop: DesktopApplication | null = null;
let quitting = false;

void app.whenReady().then(async () => {
  desktop = await createDesktopApplication();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) desktop?.createWindow();
  });
});

app.on("before-quit", (event) => {
  if (quitting || !desktop) return;
  event.preventDefault();
  const application = desktop;
  desktop = null;
  void application.dispose().finally(() => {
    quitting = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
