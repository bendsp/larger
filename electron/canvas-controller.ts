import type {
  BrowserWindow,
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  Shell,
} from "electron";
import { WebContentsView } from "electron";
import { z } from "zod";
import type { ProjectManager } from "./projects/project-manager.js";

const generationSchema = z.number().int().nonnegative();
const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
}).strict();
const loadSchema = z.object({ generation: generationSchema, url: z.string().url() }).strict();
const boundsMessageSchema = z.object({ generation: generationSchema, bounds: boundsSchema }).strict();

function loopbackOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export interface CanvasControllerDependencies {
  ipcMain: IpcMain;
  shell: Pick<Shell, "openExternal">;
  manager: ProjectManager;
  getWindow(): BrowserWindow | null;
  assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void;
}

export class CanvasController {
  private view: WebContentsView | null = null;
  private attached = false;
  private generation: number | null = null;
  private allowedOrigin: string | null = null;
  private readonly disposeProjectSubscription: () => void;

  constructor(private readonly dependencies: CanvasControllerDependencies) {
    const { ipcMain } = dependencies;
    ipcMain.handle("canvas:load", (event, raw) => this.load(event, raw));
    ipcMain.handle("canvas:navigate", (event, raw) => this.navigate(event, raw));
    ipcMain.on("canvas:bounds", (event, raw) => this.setBounds(event, raw));
    ipcMain.on("canvas:show", (event, raw) => this.show(event, raw));
    ipcMain.on("canvas:hide", (event) => this.hideFromRenderer(event));
    this.disposeProjectSubscription = dependencies.manager.subscribe((snapshot) => {
      const generation = snapshot.active?.generation ?? null;
      if (generation !== this.generation) this.reset();
    });
  }

  dispose(): void {
    this.disposeProjectSubscription();
    const { ipcMain } = this.dependencies;
    ipcMain.removeHandler("canvas:load");
    ipcMain.removeHandler("canvas:navigate");
    ipcMain.removeAllListeners("canvas:bounds");
    ipcMain.removeAllListeners("canvas:show");
    ipcMain.removeAllListeners("canvas:hide");
    this.reset();
  }

  private assertGeneration(generation: number): void {
    const active = this.dependencies.manager.snapshot().active;
    if (!active || active.generation !== generation) throw new Error("Rejected stale canvas generation");
  }

  private ensureView(generation: number): WebContentsView {
    if (this.view && this.generation === generation) return this.view;
    this.reset();
    this.generation = generation;
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        partition: `larger-canvas-${generation}`,
      },
    });
    view.setBackgroundColor("#f8f5ef");
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void this.dependencies.shell.openExternal(url);
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      const origin = loopbackOrigin(url);
      if (!origin || (this.allowedOrigin && origin !== this.allowedOrigin)) event.preventDefault();
    });
    const sendNavigation = (_event: unknown, url: string) => {
      const window = this.dependencies.getWindow();
      if (window && !window.isDestroyed() && this.generation !== null) {
        window.webContents.send("canvas:navigated", { generation: this.generation, url });
      }
    };
    view.webContents.on("did-navigate", sendNavigation);
    view.webContents.on("did-navigate-in-page", sendNavigation);
    this.view = view;
    return view;
  }

  private attach(): void {
    const window = this.dependencies.getWindow();
    if (!window || !this.view || this.attached) return;
    window.contentView.addChildView(this.view);
    this.attached = true;
  }

  private hide(): void {
    const window = this.dependencies.getWindow();
    if (!window || !this.view || !this.attached) return;
    window.contentView.removeChildView(this.view);
    this.attached = false;
  }

  private reset(): void {
    this.hide();
    this.view?.webContents.close();
    this.view = null;
    this.generation = null;
    this.allowedOrigin = null;
  }

  private async load(event: IpcMainInvokeEvent, raw: unknown): Promise<{ ok: true }> {
    this.dependencies.assertTrustedSender(event);
    const { generation, url } = loadSchema.parse(raw);
    this.assertGeneration(generation);
    const origin = loopbackOrigin(url);
    if (!origin) throw new Error("Canvas only accepts loopback HTTP origins");
    this.allowedOrigin = origin;
    const view = this.ensureView(generation);
    this.allowedOrigin = origin;
    this.attach();
    await view.webContents.loadURL(url);
    return { ok: true };
  }

  private async navigate(event: IpcMainInvokeEvent, raw: unknown): Promise<{ ok: true }> {
    this.dependencies.assertTrustedSender(event);
    const { generation, url } = loadSchema.parse(raw);
    this.assertGeneration(generation);
    const origin = loopbackOrigin(url);
    if (!origin || origin !== this.allowedOrigin || !this.view || this.generation !== generation) {
      throw new Error("Canvas navigation must stay on the active project origin");
    }
    this.attach();
    await this.view.webContents.loadURL(url);
    return { ok: true };
  }

  private setBounds(event: IpcMainEvent, raw: unknown): void {
    try {
      this.dependencies.assertTrustedSender(event);
      const { generation, bounds } = boundsMessageSchema.parse(raw);
      this.assertGeneration(generation);
      const window = this.dependencies.getWindow();
      if (!window || !this.view || this.generation !== generation) return;
      const windowBounds = window.getContentBounds();
      const x = Math.max(0, Math.min(windowBounds.width, Math.floor(bounds.x)));
      const y = Math.max(0, Math.min(windowBounds.height, Math.floor(bounds.y)));
      this.view.setBounds({
        x,
        y,
        width: Math.max(0, Math.min(windowBounds.width - x, Math.floor(bounds.width))),
        height: Math.max(0, Math.min(windowBounds.height - y, Math.floor(bounds.height))),
      });
    } catch {
      // Fire-and-forget messages fail closed.
    }
  }

  private show(event: IpcMainEvent, raw: unknown): void {
    try {
      this.dependencies.assertTrustedSender(event);
      const { generation } = z.object({ generation: generationSchema }).strict().parse(raw);
      this.assertGeneration(generation);
      if (this.view && this.allowedOrigin && this.generation === generation) this.attach();
    } catch {
      // Fire-and-forget messages fail closed.
    }
  }

  private hideFromRenderer(event: IpcMainEvent): void {
    try {
      this.dependencies.assertTrustedSender(event);
      this.hide();
    } catch {
      // Fire-and-forget messages fail closed.
    }
  }
}
