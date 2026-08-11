import type {
  BrowserWindow,
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
} from "electron";
import { WebContentsView } from "electron";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProjectManager } from "./projects/project-manager.js";
import { resolveCanvasNavigation } from "./canvas-security.js";

const generationSchema = z.number().int().nonnegative();
const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
}).strict();
const surfaceIdSchema = z.string().min(1).max(256);
const routeSchema = z.string().startsWith("/").max(2048)
  .refine((route) => !route.startsWith("//") && !route.includes("\\"), {
    message: "route must be project-relative",
  });
const loadSchema = z.object({ generation: generationSchema, surfaceId: surfaceIdSchema }).strict();
const navigateSchema = z.object({
  generation: generationSchema,
  surfaceId: surfaceIdSchema,
  route: routeSchema,
}).strict();
const boundsMessageSchema = z.object({ generation: generationSchema, bounds: boundsSchema }).strict();

function loopbackOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port)
      && !url.username && !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export interface CanvasRuntimeSurfaceResolver {
  resolveSurface(generation: number, surfaceId: string): string | undefined;
  subscribe(listener: () => void): () => void;
}

export interface CanvasControllerDependencies {
  ipcMain: IpcMain;
  manager: ProjectManager;
  runtime: CanvasRuntimeSurfaceResolver;
  getWindow(): BrowserWindow | null;
  assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void;
}

export class CanvasController {
  private view: WebContentsView | null = null;
  private attached = false;
  private generation: number | null = null;
  private surfaceId: string | null = null;
  private allowedOrigin: string | null = null;
  private readonly disposeProjectSubscription: () => void;
  private readonly disposeRuntimeSubscription: () => void;

  constructor(private readonly dependencies: CanvasControllerDependencies) {
    const { ipcMain } = dependencies;
    ipcMain.handle("canvas:load", (event, raw) => this.load(event, raw));
    ipcMain.handle("canvas:navigate", (event, raw) => this.navigate(event, raw));
    ipcMain.on("canvas:bounds", (event, raw) => this.setBounds(event, raw));
    ipcMain.on("canvas:show", (event, raw) => this.show(event, raw));
    ipcMain.on("canvas:focus", (event, raw) => this.focus(event, raw));
    ipcMain.on("canvas:hide", (event) => this.hideFromRenderer(event));
    this.disposeProjectSubscription = dependencies.manager.subscribe((snapshot) => {
      const generation = snapshot.active?.generation ?? null;
      if (generation !== this.generation || snapshot.active?.trust !== "trusted") this.reset();
    });
    this.disposeRuntimeSubscription = dependencies.runtime.subscribe(() => {
      if (this.generation === null || this.surfaceId === null) return;
      if (!dependencies.runtime.resolveSurface(this.generation, this.surfaceId)) this.reset();
    });
  }

  dispose(): void {
    this.disposeProjectSubscription();
    this.disposeRuntimeSubscription();
    const { ipcMain } = this.dependencies;
    ipcMain.removeHandler("canvas:load");
    ipcMain.removeHandler("canvas:navigate");
    ipcMain.removeAllListeners("canvas:bounds");
    ipcMain.removeAllListeners("canvas:show");
    ipcMain.removeAllListeners("canvas:focus");
    ipcMain.removeAllListeners("canvas:hide");
    this.reset();
  }

  private assertGeneration(generation: number): void {
    const active = this.dependencies.manager.snapshot().active;
    if (!active || active.generation !== generation) throw new Error("Rejected stale canvas generation");
  }

  private ensureView(generation: number, surfaceId: string): WebContentsView {
    if (this.view && this.generation === generation && this.surfaceId === surfaceId) return this.view;
    this.reset();
    this.generation = generation;
    this.surfaceId = surfaceId;
    const partitionKey = createHash("sha256").update(`${generation}\0${surfaceId}`).digest("hex").slice(0, 24);
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        partition: `larger-canvas-${partitionKey}`,
      },
    });
    view.setBackgroundColor("#f8f5ef");
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event, url) => {
      const origin = loopbackOrigin(url);
      if (!origin || (this.allowedOrigin && origin !== this.allowedOrigin)) event.preventDefault();
    });
    const sendNavigation = (_event: unknown, url: string) => {
      const window = this.dependencies.getWindow();
      const parsed = new URL(url);
      if (window && !window.isDestroyed() && this.generation !== null && this.surfaceId !== null
        && parsed.origin === this.allowedOrigin) {
        window.webContents.send("canvas:navigated", {
          generation: this.generation,
          surfaceId: this.surfaceId,
          route: `${parsed.pathname}${parsed.search}${parsed.hash}`,
        });
      }
    };
    view.webContents.on("did-navigate", sendNavigation);
    view.webContents.on("did-navigate-in-page", sendNavigation);
    view.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.key !== "Escape") return;
      event.preventDefault();
      const window = this.dependencies.getWindow();
      if (!window || window.isDestroyed() || this.generation === null || this.surfaceId === null) return;
      window.webContents.focus();
      window.webContents.send("canvas:focus-return", {
        generation: this.generation,
        surfaceId: this.surfaceId,
      });
    });
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
    this.surfaceId = null;
    this.allowedOrigin = null;
  }

  private resolveSurface(generation: number, surfaceId: string): { url: string; origin: string } {
    this.assertGeneration(generation);
    const url = this.dependencies.runtime.resolveSurface(generation, surfaceId);
    const origin = url ? loopbackOrigin(url) : null;
    if (!url || !origin) throw new Error("Rejected inactive or unsafe canvas surface");
    return { url, origin };
  }

  private async load(event: IpcMainInvokeEvent, raw: unknown): Promise<{ ok: true }> {
    this.dependencies.assertTrustedSender(event);
    const { generation, surfaceId } = loadSchema.parse(raw);
    const { url, origin } = this.resolveSurface(generation, surfaceId);
    const existingSurface = Boolean(
      this.view && this.generation === generation && this.surfaceId === surfaceId,
    );
    this.allowedOrigin = origin;
    const view = this.ensureView(generation, surfaceId);
    this.allowedOrigin = origin;
    this.attach();
    if (!existingSurface) await view.webContents.loadURL(url);
    return { ok: true };
  }

  private async navigate(event: IpcMainInvokeEvent, raw: unknown): Promise<{ ok: true }> {
    this.dependencies.assertTrustedSender(event);
    const { generation, surfaceId, route } = navigateSchema.parse(raw);
    const surface = this.resolveSurface(generation, surfaceId);
    if (surface.origin !== this.allowedOrigin || !this.view || this.generation !== generation || this.surfaceId !== surfaceId) {
      throw new Error("Canvas navigation must stay on the active project origin");
    }
    const url = resolveCanvasNavigation(surface.url, this.allowedOrigin, route);
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
      const { generation, surfaceId } = loadSchema.parse(raw);
      this.assertGeneration(generation);
      if (this.view && this.allowedOrigin && this.generation === generation && this.surfaceId === surfaceId
        && this.dependencies.runtime.resolveSurface(generation, surfaceId)) this.attach();
    } catch {
      // Fire-and-forget messages fail closed.
    }
  }

  private focus(event: IpcMainEvent, raw: unknown): void {
    try {
      this.dependencies.assertTrustedSender(event);
      const { generation, surfaceId } = loadSchema.parse(raw);
      this.assertGeneration(generation);
      if (this.view && this.attached && this.generation === generation && this.surfaceId === surfaceId
        && this.dependencies.runtime.resolveSurface(generation, surfaceId)) {
        this.dependencies.getWindow()?.focus();
        this.view.webContents.focus();
      }
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
