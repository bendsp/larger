import type { BrowserWindow, WebContentsView } from "electron";
import { createHash } from "node:crypto";
import {
  CANVAS_IPC_CHANNELS,
  canvasAckSchema,
  canvasBoundsInputSchema,
  canvasFocusReturnSchema,
  canvasNavigateInputSchema,
  canvasNavigationSchema,
  canvasSurfaceInputSchema,
} from "../src/desktop/canvas-contract.js";
import type {
  DesktopIpcOperationContext,
  DesktopIpcRouter,
} from "./ipc/desktop-ipc-router.js";
import type { ProjectManager } from "./projects/project-manager.js";
import { resolveCanvasNavigation } from "./canvas-security.js";

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
  readonly router: DesktopIpcRouter;
  readonly manager: ProjectManager;
  readonly runtime: CanvasRuntimeSurfaceResolver;
  readonly getWindow: () => BrowserWindow | null;
  readonly createView: (options: {
    webPreferences: {
      nodeIntegration: false;
      contextIsolation: true;
      sandbox: true;
      webSecurity: true;
      partition: string;
    };
  }) => WebContentsView;
}

export class CanvasController {
  private view: WebContentsView | null = null;
  private attachedWindow: BrowserWindow | null = null;
  private generation: number | null = null;
  private surfaceId: string | null = null;
  private ownerClientId: string | null = null;
  private allowedOrigin: string | null = null;
  private readonly disposeProjectSubscription: () => void;
  private readonly disposeRuntimeSubscription: () => void;
  private readonly disposeClientSubscription: () => void;
  private readonly disposeIpc: readonly (() => void)[];

  constructor(private readonly dependencies: CanvasControllerDependencies) {
    const { router } = dependencies;
    this.disposeIpc = [
      router.register({
        channel: CANVAS_IPC_CHANNELS.load,
        input: canvasSurfaceInputSchema,
        output: canvasAckSchema,
        failureCode: "canvas-operation-failed",
        run: (input, context) => this.load(input.generation, input.surfaceId, context),
      }),
      router.register({
        channel: CANVAS_IPC_CHANNELS.navigate,
        input: canvasNavigateInputSchema,
        output: canvasAckSchema,
        failureCode: "canvas-operation-failed",
        run: (input, context) => this.navigate(input.generation, input.surfaceId, input.route, context),
      }),
      router.listen({
        channel: CANVAS_IPC_CHANNELS.bounds,
        input: canvasBoundsInputSchema,
        run: ({ generation, surfaceId, bounds }, context) => (
          this.setBounds(generation, surfaceId, context.clientId, bounds)
        ),
      }),
      router.listen({
        channel: CANVAS_IPC_CHANNELS.show,
        input: canvasSurfaceInputSchema,
        run: ({ generation, surfaceId }, context) => this.show(generation, surfaceId, context.clientId),
      }),
      router.listen({
        channel: CANVAS_IPC_CHANNELS.focus,
        input: canvasSurfaceInputSchema,
        run: ({ generation, surfaceId }, context) => this.focus(generation, surfaceId, context.clientId),
      }),
      router.listen({
        channel: CANVAS_IPC_CHANNELS.hide,
        input: canvasSurfaceInputSchema,
        run: ({ generation, surfaceId }, context) => this.hideSurface(generation, surfaceId, context.clientId),
      }),
    ];
    this.disposeProjectSubscription = dependencies.manager.subscribe((snapshot) => {
      const generation = snapshot.active?.generation ?? null;
      if (generation !== this.generation || snapshot.active?.trust !== "trusted") this.reset();
    });
    this.disposeRuntimeSubscription = dependencies.runtime.subscribe(() => {
      if (this.generation === null || this.surfaceId === null) return;
      if (!dependencies.runtime.resolveSurface(this.generation, this.surfaceId)) this.reset();
    });
    this.disposeClientSubscription = router.onClientRevoked((clientId) => {
      if (clientId === this.ownerClientId) this.reset();
    });
  }

  dispose(): void {
    this.disposeProjectSubscription();
    this.disposeRuntimeSubscription();
    this.disposeClientSubscription();
    for (const dispose of this.disposeIpc) dispose();
    this.reset();
  }

  detachWindow(window?: BrowserWindow): void {
    if (window && this.attachedWindow && window !== this.attachedWindow) return;
    this.reset();
  }

  reset(): void {
    this.hide();
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    this.generation = null;
    this.surfaceId = null;
    this.ownerClientId = null;
    this.allowedOrigin = null;
  }

  private assertGeneration(generation: number): void {
    const active = this.dependencies.manager.snapshot().active;
    if (!active || active.generation !== generation) throw new Error("Rejected stale canvas generation");
  }

  private ensureView(generation: number, surfaceId: string, clientId: string): WebContentsView {
    if (
      this.view
      && this.generation === generation
      && this.surfaceId === surfaceId
      && this.ownerClientId === clientId
    ) return this.view;
    this.reset();
    this.generation = generation;
    this.surfaceId = surfaceId;
    this.ownerClientId = clientId;
    const partitionKey = createHash("sha256").update(`${generation}\0${surfaceId}`).digest("hex").slice(0, 24);
    const view = this.dependencies.createView({
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
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      const window = this.dependencies.getWindow();
      if (this.generation === null || this.surfaceId === null || parsed.origin !== this.allowedOrigin) return;
      this.dependencies.router.publish(
        window,
        CANVAS_IPC_CHANNELS.navigated,
        "canvas.navigated",
        canvasNavigationSchema,
        {
          generation: this.generation,
          surfaceId: this.surfaceId,
          route: `${parsed.pathname}${parsed.search}${parsed.hash}`,
        },
      );
    };
    view.webContents.on("did-navigate", sendNavigation);
    view.webContents.on("did-navigate-in-page", sendNavigation);
    view.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.key !== "Escape") return;
      event.preventDefault();
      const window = this.dependencies.getWindow();
      if (!window || window.isDestroyed() || this.generation === null || this.surfaceId === null) return;
      window.webContents.focus();
      this.dependencies.router.publish(
        window,
        CANVAS_IPC_CHANNELS.focusReturn,
        "canvas.focus-return",
        canvasFocusReturnSchema,
        { generation: this.generation, surfaceId: this.surfaceId },
      );
    });
    this.view = view;
    return view;
  }

  private attach(): void {
    const window = this.dependencies.getWindow();
    if (!window || window.isDestroyed() || !this.view) return;
    if (this.attachedWindow === window) return;
    this.hide();
    window.contentView.addChildView(this.view);
    this.attachedWindow = window;
  }

  private hide(): void {
    const window = this.attachedWindow;
    this.attachedWindow = null;
    if (!window || window.isDestroyed() || !this.view) return;
    window.contentView.removeChildView(this.view);
  }

  private resolveSurface(generation: number, surfaceId: string): { url: string; origin: string } {
    this.assertGeneration(generation);
    const url = this.dependencies.runtime.resolveSurface(generation, surfaceId);
    const origin = url ? loopbackOrigin(url) : null;
    if (!url || !origin) throw new Error("Rejected inactive or unsafe canvas surface");
    return { url, origin };
  }

  private async load(
    generation: number,
    surfaceId: string,
    context: DesktopIpcOperationContext,
  ): Promise<{ ok: true }> {
    context.assertCurrent();
    const { url, origin } = this.resolveSurface(generation, surfaceId);
    const existingSurface = Boolean(
      this.view
      && this.generation === generation
      && this.surfaceId === surfaceId
      && this.ownerClientId === context.clientId,
    );
    this.allowedOrigin = origin;
    const view = this.ensureView(generation, surfaceId, context.clientId);
    this.allowedOrigin = origin;
    this.attach();
    try {
      if (!existingSurface) await view.webContents.loadURL(url);
      context.assertCurrent();
      return { ok: true };
    } catch (cause) {
      if (this.view === view && this.ownerClientId === context.clientId) this.reset();
      throw cause;
    }
  }

  private async navigate(
    generation: number,
    surfaceId: string,
    route: string,
    context: DesktopIpcOperationContext,
  ): Promise<{ ok: true }> {
    context.assertCurrent();
    const surface = this.resolveSurface(generation, surfaceId);
    if (
      surface.origin !== this.allowedOrigin
      || !this.view
      || this.generation !== generation
      || this.surfaceId !== surfaceId
      || this.ownerClientId !== context.clientId
    ) {
      throw new Error("Canvas navigation must stay on the active project origin");
    }
    const url = resolveCanvasNavigation(surface.url, this.allowedOrigin, route);
    this.attach();
    const view = this.view;
    try {
      await view.webContents.loadURL(url);
      context.assertCurrent();
      return { ok: true };
    } catch (cause) {
      if (this.view === view && this.ownerClientId === context.clientId) this.reset();
      throw cause;
    }
  }

  private setBounds(
    generation: number,
    surfaceId: string,
    clientId: string,
    bounds: { x: number; y: number; width: number; height: number },
  ): void {
    this.assertGeneration(generation);
    const window = this.attachedWindow;
    if (
      !window
      || window.isDestroyed()
      || !this.view
      || this.generation !== generation
      || this.surfaceId !== surfaceId
      || this.ownerClientId !== clientId
    ) return;
    const windowBounds = window.getContentBounds();
    const x = Math.max(0, Math.min(windowBounds.width, Math.floor(bounds.x)));
    const y = Math.max(0, Math.min(windowBounds.height, Math.floor(bounds.y)));
    this.view.setBounds({
      x,
      y,
      width: Math.max(0, Math.min(windowBounds.width - x, Math.floor(bounds.width))),
      height: Math.max(0, Math.min(windowBounds.height - y, Math.floor(bounds.height))),
    });
  }

  private show(generation: number, surfaceId: string, clientId: string): void {
    this.assertGeneration(generation);
    if (
      this.view
      && this.allowedOrigin
      && this.generation === generation
      && this.surfaceId === surfaceId
      && this.ownerClientId === clientId
      && this.dependencies.runtime.resolveSurface(generation, surfaceId)
    ) this.attach();
  }

  private focus(generation: number, surfaceId: string, clientId: string): void {
    this.assertGeneration(generation);
    if (
      this.view
      && this.attachedWindow
      && this.generation === generation
      && this.surfaceId === surfaceId
      && this.ownerClientId === clientId
      && this.dependencies.runtime.resolveSurface(generation, surfaceId)
    ) {
      this.attachedWindow.focus();
      this.view.webContents.focus();
    }
  }

  private hideSurface(generation: number, surfaceId: string, clientId: string): void {
    this.assertGeneration(generation);
    if (
      this.generation !== generation
      || this.surfaceId !== surfaceId
      || this.ownerClientId !== clientId
    ) return;
    this.hide();
  }
}
