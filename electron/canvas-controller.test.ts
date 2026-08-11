import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { BrowserWindow, WebContentsView } from "electron";
import type { ZodType } from "zod";
import {
  CANVAS_IPC_CHANNELS,
  type CanvasBounds,
} from "../src/desktop/canvas-contract.js";
import type {
  DesktopIpcCommand,
  DesktopIpcOperation,
  DesktopIpcRouter,
} from "./ipc/desktop-ipc-router.js";
import type { ProjectManager } from "./projects/project-manager.js";
import { CanvasController, type CanvasRuntimeSurfaceResolver } from "./canvas-controller.js";

class FakeCanvasContents extends EventEmitter {
  readonly loaded: string[] = [];
  readonly session = {
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
  };
  closed = false;
  focused = false;
  setWindowOpenHandler(): { action: "deny" } { return { action: "deny" }; }
  async loadURL(url: string): Promise<void> { this.loaded.push(url); }
  isDestroyed(): boolean { return this.closed; }
  close(): void { this.closed = true; }
  focus(): void { this.focused = true; }
}

class FakeCanvasView {
  readonly webContents = new FakeCanvasContents();
  readonly bounds: CanvasBounds[] = [];
  setBackgroundColor(): void {}
  setBounds(bounds: CanvasBounds): void { this.bounds.push(bounds); }
}

test("canvas commands are scoped to the exact generation and surface", async () => {
  const operations = new Map<string, DesktopIpcOperation<unknown, unknown>>();
  const commands = new Map<string, DesktopIpcCommand<unknown>>();
  const revocationListeners = new Set<(clientId: string) => void>();
  let disposedHandlers = 0;
  const router = {
    register: (operation: DesktopIpcOperation<unknown, unknown>) => {
      operations.set(operation.channel, operation);
      return () => { operations.delete(operation.channel); disposedHandlers += 1; };
    },
    listen: (command: DesktopIpcCommand<unknown>) => {
      commands.set(command.channel, command);
      return () => { commands.delete(command.channel); disposedHandlers += 1; };
    },
    publish: <T>(
      _window: BrowserWindow | null,
      _channel: string,
      _stream: string,
      schema: ZodType<T>,
      payload: T,
    ) => schema.safeParse(payload).success,
    onClientRevoked: (listener: (clientId: string) => void) => {
      revocationListeners.add(listener);
      return () => { revocationListeners.delete(listener); };
    },
  } as unknown as DesktopIpcRouter;

  const projectListeners = new Set<(snapshot: ReturnType<ProjectManager["snapshot"]>) => void>();
  const manager = {
    snapshot: () => ({ active: { generation: 7, trust: "trusted" } }),
    subscribe: (listener: (snapshot: ReturnType<ProjectManager["snapshot"]>) => void) => {
      projectListeners.add(listener);
      return () => projectListeners.delete(listener);
    },
  } as unknown as ProjectManager;
  const runtimeListeners = new Set<() => void>();
  const runtime: CanvasRuntimeSurfaceResolver = {
    resolveSurface: (generation, surfaceId) => generation === 7 && surfaceId === "surface-a"
      ? "http://127.0.0.1:4400/"
      : undefined,
    subscribe: (listener) => {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
  };
  const added: unknown[] = [];
  const removed: unknown[] = [];
  let windowFocused = false;
  const window = {
    isDestroyed: () => false,
    contentView: {
      addChildView: (view: unknown) => added.push(view),
      removeChildView: (view: unknown) => removed.push(view),
    },
    getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    focus: () => { windowFocused = true; },
    webContents: { id: 1, focus: () => undefined },
  } as unknown as BrowserWindow;
  const view = new FakeCanvasView();
  const controller = new CanvasController({
    router,
    manager,
    runtime,
    getWindow: () => window,
    createView: () => view as unknown as WebContentsView,
  });
  const context = {
    clientId: "client-a",
    requestId: "request-a",
    signal: new AbortController().signal,
    isCurrent: () => true,
    assertCurrent: () => undefined,
  };

  const load = operations.get(CANVAS_IPC_CHANNELS.load)!;
  await load.run({ generation: 7, surfaceId: "surface-a" }, context);
  assert.deepEqual(view.webContents.loaded, ["http://127.0.0.1:4400/"]);
  assert.equal(added.length, 1);

  const bounds = commands.get(CANVAS_IPC_CHANNELS.bounds)!;
  await bounds.run({
    generation: 7,
    surfaceId: "surface-b",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
  }, context);
  assert.equal(view.bounds.length, 0);
  await bounds.run({
    generation: 7,
    surfaceId: "surface-a",
    bounds: { x: -10, y: 20, width: 900, height: 700 },
  }, context);
  assert.deepEqual(view.bounds, [{ x: 0, y: 20, width: 800, height: 580 }]);

  const hide = commands.get(CANVAS_IPC_CHANNELS.hide)!;
  await hide.run({ generation: 7, surfaceId: "surface-b" }, context);
  assert.equal(removed.length, 0);
  await hide.run(
    { generation: 7, surfaceId: "surface-a" },
    { ...context, clientId: "stale-client" },
  );
  assert.equal(removed.length, 0);
  await hide.run({ generation: 7, surfaceId: "surface-a" }, context);
  assert.equal(removed.length, 1);

  const show = commands.get(CANVAS_IPC_CHANNELS.show)!;
  await show.run({ generation: 7, surfaceId: "surface-a" }, context);
  assert.equal(added.length, 2);
  const focus = commands.get(CANVAS_IPC_CHANNELS.focus)!;
  await focus.run({ generation: 7, surfaceId: "surface-a" }, context);
  assert.equal(windowFocused, true);
  assert.equal(view.webContents.focused, true);

  controller.detachWindow(window);
  assert.equal(removed.length, 2);
  assert.equal(view.webContents.closed, true);
  controller.dispose();
  assert.equal(disposedHandlers, 6);
  assert.equal(projectListeners.size, 0);
  assert.equal(runtimeListeners.size, 0);
  assert.equal(revocationListeners.size, 0);
});

test("revoking the owning renderer document resets its canvas view", async () => {
  const operations = new Map<string, DesktopIpcOperation<unknown, unknown>>();
  const revocationListeners = new Set<(clientId: string) => void>();
  const router = {
    register: (operation: DesktopIpcOperation<unknown, unknown>) => {
      operations.set(operation.channel, operation);
      return () => operations.delete(operation.channel);
    },
    listen: () => () => undefined,
    publish: () => true,
    onClientRevoked: (listener: (clientId: string) => void) => {
      revocationListeners.add(listener);
      return () => revocationListeners.delete(listener);
    },
  } as unknown as DesktopIpcRouter;
  const manager = {
    snapshot: () => ({ active: { generation: 7, trust: "trusted" } }),
    subscribe: () => () => undefined,
  } as unknown as ProjectManager;
  const runtime: CanvasRuntimeSurfaceResolver = {
    resolveSurface: () => "http://127.0.0.1:4400/",
    subscribe: () => () => undefined,
  };
  const removed: unknown[] = [];
  const window = {
    isDestroyed: () => false,
    contentView: {
      addChildView: () => undefined,
      removeChildView: (view: unknown) => removed.push(view),
    },
    webContents: { id: 1 },
  } as unknown as BrowserWindow;
  const view = new FakeCanvasView();
  const controller = new CanvasController({
    router,
    manager,
    runtime,
    getWindow: () => window,
    createView: () => view as unknown as WebContentsView,
  });
  const context = {
    clientId: "client-a",
    requestId: "request-a",
    signal: new AbortController().signal,
    isCurrent: () => true,
    assertCurrent: () => undefined,
  };
  await operations.get(CANVAS_IPC_CHANNELS.load)!.run(
    { generation: 7, surfaceId: "surface-a" },
    context,
  );
  for (const listener of revocationListeners) listener("client-a");
  assert.equal(removed.length, 1);
  assert.equal(view.webContents.closed, true);
  controller.dispose();
});
