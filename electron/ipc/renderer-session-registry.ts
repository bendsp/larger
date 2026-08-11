import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
} from "electron";
import {
  DesktopBridgeError,
  type DesktopSessionInfo,
} from "../../src/desktop/protocol.js";

export type RendererIpcEvent = IpcMainEvent | IpcMainInvokeEvent;

interface RendererSessionRecord {
  readonly clientId: string;
  readonly webContentsId: number;
  readonly frame: NonNullable<RendererIpcEvent["senderFrame"]>;
  readonly controller: AbortController;
}

interface TrackedWebContents {
  readonly contents: WebContents;
  readonly dispose: () => void;
}

function unauthorized(message: string): DesktopBridgeError {
  return new DesktopBridgeError({ code: "unauthorized", message, retryable: false });
}

function staleClient(): DesktopBridgeError {
  return new DesktopBridgeError({
    code: "stale-client",
    message: "This renderer document is no longer active.",
    retryable: true,
  });
}

export class RendererSessionRegistry {
  private readonly sessionsByClient = new Map<string, RendererSessionRecord>();
  private readonly clientByWebContents = new Map<number, string>();
  private readonly trackedWebContents = new Map<number, TrackedWebContents>();
  private readonly revocationListeners = new Set<(clientId: string) => void>();
  private disposed = false;

  constructor(readonly bootId: string) {}

  connect(event: RendererIpcEvent, clientId: string): DesktopSessionInfo {
    this.assertMainFrame(event);
    if (this.disposed) throw staleClient();
    this.revokeWebContents(event.sender.id);
    this.revokeClient(clientId);
    this.track(event.sender);
    const frame = event.senderFrame;
    if (!frame) throw unauthorized("Renderer sessions are only available to the main frame.");
    const record: RendererSessionRecord = {
      clientId,
      webContentsId: event.sender.id,
      frame,
      controller: new AbortController(),
    };
    this.sessionsByClient.set(clientId, record);
    this.clientByWebContents.set(event.sender.id, clientId);
    return { protocolVersion: 1, bootId: this.bootId, clientId };
  }

  authorize(event: RendererIpcEvent, clientId: string): RendererSessionRecord {
    this.assertMainFrame(event);
    const record = this.sessionsByClient.get(clientId);
    if (
      !record
      || record.webContentsId !== event.sender.id
      || record.frame !== event.senderFrame
      || record.controller.signal.aborted
      || this.clientByWebContents.get(event.sender.id) !== clientId
    ) {
      throw staleClient();
    }
    return record;
  }

  isCurrent(event: RendererIpcEvent, clientId: string): boolean {
    try {
      this.authorize(event, clientId);
      return true;
    } catch {
      return false;
    }
  }

  currentClientForWebContents(webContentsId: number): string | null {
    const clientId = this.clientByWebContents.get(webContentsId);
    if (!clientId) return null;
    const record = this.sessionsByClient.get(clientId);
    return record && record.webContentsId === webContentsId && !record.controller.signal.aborted
      ? clientId
      : null;
  }

  signalFor(clientId: string): AbortSignal | null {
    return this.sessionsByClient.get(clientId)?.controller.signal ?? null;
  }

  revokeWebContents(webContentsId: number): void {
    const clientId = this.clientByWebContents.get(webContentsId);
    if (!clientId) return;
    this.clientByWebContents.delete(webContentsId);
    const record = this.sessionsByClient.get(clientId);
    if (!record || record.webContentsId !== webContentsId) return;
    this.revokeClient(clientId);
  }

  subscribeRevoked(listener: (clientId: string) => void): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const webContentsId of [...this.clientByWebContents.keys()]) this.revokeWebContents(webContentsId);
    for (const tracked of this.trackedWebContents.values()) tracked.dispose();
    this.trackedWebContents.clear();
    this.revocationListeners.clear();
  }

  private assertMainFrame(event: RendererIpcEvent): void {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
      throw unauthorized("Desktop operations are restricted to the active main frame.");
    }
  }

  private track(contents: WebContents): void {
    if (this.trackedWebContents.has(contents.id)) return;
    const revoke = () => this.revokeWebContents(contents.id);
    const didStartNavigation = (
      _event: unknown,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame && !isInPlace) revoke();
    };
    const destroyed = () => {
      revoke();
      this.trackedWebContents.get(contents.id)?.dispose();
      this.trackedWebContents.delete(contents.id);
    };
    contents.on("did-start-navigation", didStartNavigation);
    contents.on("render-process-gone", revoke);
    contents.on("destroyed", destroyed);
    const dispose = () => {
      contents.removeListener("did-start-navigation", didStartNavigation);
      contents.removeListener("render-process-gone", revoke);
      contents.removeListener("destroyed", destroyed);
    };
    this.trackedWebContents.set(contents.id, { contents, dispose });
  }

  private revokeClient(clientId: string): void {
    const record = this.sessionsByClient.get(clientId);
    if (!record) return;
    this.sessionsByClient.delete(clientId);
    if (this.clientByWebContents.get(record.webContentsId) === clientId) {
      this.clientByWebContents.delete(record.webContentsId);
    }
    record.controller.abort(new Error("Renderer document was revoked"));
    for (const listener of this.revocationListeners) listener(clientId);
  }
}
