import type { ZodType } from "zod";

import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_PROTOCOL_VERSION,
  DesktopBridgeError,
  desktopEventEnvelopeSchema,
  desktopResponseEnvelopeSchema,
  desktopSessionInfoSchema,
  type DesktopRequestEnvelope,
  type DesktopSessionInfo,
} from "../src/desktop/protocol.js";
import type { PreloadTransport } from "./preload-bridge.js";

type RendererListener = (event: unknown, raw: unknown) => void;

export interface PreloadIpcRenderer {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  send(channel: string, payload: unknown): void;
  on(channel: string, listener: RendererListener): void;
  removeListener(channel: string, listener: RendererListener): void;
}

export function createPreloadTransport(options: {
  readonly ipcRenderer: PreloadIpcRenderer;
  readonly createId: () => string;
  readonly reportFailure: (cause: unknown) => void;
}): PreloadTransport {
  const { ipcRenderer, createId, reportFailure } = options;
  const clientId = createId();
  const request = <T>(payload: T): DesktopRequestEnvelope<T> => ({
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    requestId: createId(),
    clientId,
    payload,
  });
  const connectRequest = request({});
  const sessionPromise: Promise<DesktopSessionInfo> = ipcRenderer
    .invoke(DESKTOP_IPC_CHANNELS.connect, connectRequest)
    .then((raw) => {
      const response = desktopResponseEnvelopeSchema(desktopSessionInfoSchema).parse(raw);
      if (response.requestId !== connectRequest.requestId) {
        throw new Error("Electron returned a response for a different session request");
      }
      if (!response.ok) throw new DesktopBridgeError(response.error);
      if (response.value.clientId !== clientId || response.value.bootId !== response.bootId) {
        throw new Error("Electron returned an inconsistent renderer session");
      }
      return response.value;
    });
  void sessionPromise.catch(reportFailure);

  return {
    async invoke<T>(channel: string, schema: ZodType<T>, payload: unknown = {}): Promise<T> {
      const session = await sessionPromise;
      const desktopRequest = request(payload);
      const raw = await ipcRenderer.invoke(channel, desktopRequest);
      const response = desktopResponseEnvelopeSchema(schema).parse(raw);
      if (response.requestId !== desktopRequest.requestId || response.bootId !== session.bootId) {
        throw new Error("Electron returned a stale or mismatched desktop response");
      }
      if (!response.ok) throw new DesktopBridgeError(response.error);
      return response.value;
    },
    send(channel, payload) {
      void sessionPromise
        .then(() => ipcRenderer.send(channel, request(payload)))
        .catch(reportFailure);
    },
    subscribe<T>(channel: string, stream: string, schema: ZodType<T>, listener: (value: T) => void): () => void {
      let disposed = false;
      let lastSequence = 0;
      const handler: RendererListener = (_event, raw) => {
        void sessionPromise.then((session) => {
          if (disposed) return;
          const envelope = desktopEventEnvelopeSchema(stream, schema).parse(raw);
          if (
            envelope.bootId !== session.bootId
            || envelope.clientId !== clientId
            || envelope.sequence <= lastSequence
          ) return;
          lastSequence = envelope.sequence;
          listener(envelope.payload);
        }).catch(reportFailure);
      };
      ipcRenderer.on(channel, handler);
      return () => {
        disposed = true;
        ipcRenderer.removeListener(channel, handler);
      };
    },
  };
}
