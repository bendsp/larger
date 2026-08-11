import type {
  BrowserWindow,
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
} from "electron";
import { randomUUID } from "node:crypto";
import { ZodError, z, type ZodType } from "zod";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_PROTOCOL_VERSION,
  DesktopBridgeError,
  desktopClientIdSchema,
  desktopEventEnvelopeSchema,
  desktopRequestIdSchema,
  desktopResponseEnvelopeSchema,
  desktopSessionInfoSchema,
  type DesktopError,
  type DesktopErrorCode,
  type DesktopEventEnvelope,
  type DesktopRequestEnvelope,
  type DesktopResponseEnvelope,
} from "../../src/desktop/protocol.js";
import {
  RendererSessionRegistry,
  type RendererIpcEvent,
} from "./renderer-session-registry.js";

const emptyPayloadSchema = z.object({}).strict();

const connectRequestSchema = z.object({
  protocolVersion: z.literal(DESKTOP_PROTOCOL_VERSION),
  requestId: desktopRequestIdSchema,
  clientId: desktopClientIdSchema,
  payload: emptyPayloadSchema,
}).strict();

export interface DesktopIpcOperationContext {
  readonly clientId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  assertCurrent(): void;
}

export interface DesktopIpcOperation<TInput, TOutput> {
  readonly channel: string;
  readonly input: ZodType<TInput>;
  readonly output: ZodType<TOutput>;
  readonly failureCode: DesktopErrorCode;
  readonly run: (
    input: TInput,
    context: DesktopIpcOperationContext,
  ) => Promise<TOutput> | TOutput;
}

export interface DesktopIpcCommand<TInput> {
  readonly channel: string;
  readonly input: ZodType<TInput>;
  readonly run: (input: TInput, context: DesktopIpcOperationContext) => Promise<void> | void;
}

export interface DesktopIpcRouterDependencies {
  readonly ipcMain: IpcMain;
  readonly sessions: RendererSessionRegistry;
  readonly assertTrustedSender: (event: RendererIpcEvent) => void;
  readonly onContractViolation?: (error: DesktopBridgeError) => void;
  readonly onUnexpectedError?: (
    cause: unknown,
    context: { readonly channel: string; readonly failureCode: DesktopErrorCode },
  ) => void;
}

function responseMetadata(raw: unknown): { requestId: string; protocolVersion: unknown } {
  if (!raw || typeof raw !== "object") return { requestId: randomUUID(), protocolVersion: undefined };
  const value = raw as { requestId?: unknown; protocolVersion?: unknown };
  const requestId = desktopRequestIdSchema.safeParse(value.requestId);
  return {
    requestId: requestId.success ? requestId.data : randomUUID(),
    protocolVersion: value.protocolVersion,
  };
}

function sanitizeDetails(error: ZodError): DesktopError["details"] {
  return {
    issues: error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "payload"}: ${issue.code}`),
  };
}

function operationError(cause: unknown, fallback: DesktopErrorCode): DesktopError {
  if (cause instanceof DesktopBridgeError) {
    return {
      code: cause.code,
      message: cause.message,
      retryable: cause.retryable,
      ...(cause.details ? { details: cause.details } : {}),
    };
  }
  const message = cause instanceof Error ? cause.message : "";
  if (/stale.*generation|generation.*stale/i.test(message)) {
    return { code: "stale-generation", message: "The active project changed. Refresh and try again.", retryable: true };
  }
  if (/stale.*revision|revision.*stale/i.test(message)) {
    return { code: "stale-revision", message: "The desktop state changed. Refresh and try again.", retryable: true };
  }
  if (/cancel/i.test(message)) return { code: "cancelled", message: "The desktop operation was cancelled.", retryable: true };
  return { code: fallback, message: "The desktop operation could not be completed.", retryable: true };
}

export class DesktopIpcRouter {
  private readonly invokeChannels = new Set<string>();
  private readonly commandListeners = new Map<string, (event: IpcMainEvent, raw: unknown) => void>();
  private readonly sequences = new Map<string, number>();
  private readonly disposeSequenceCleanup: () => void;
  private disposed = false;

  constructor(private readonly dependencies: DesktopIpcRouterDependencies) {
    this.disposeSequenceCleanup = dependencies.sessions.subscribeRevoked((clientId) => {
      const prefix = `${clientId}\0`;
      for (const key of this.sequences.keys()) {
        if (key.startsWith(prefix)) this.sequences.delete(key);
      }
    });
    this.registerHandshake();
  }

  register<TInput, TOutput>(operation: DesktopIpcOperation<TInput, TOutput>): () => void {
    this.assertRegisterable(operation.channel);
    const { ipcMain } = this.dependencies;
    this.invokeChannels.add(operation.channel);
    ipcMain.handle(operation.channel, (event, raw) => this.invoke(event, raw, operation));
    return () => {
      if (!this.invokeChannels.delete(operation.channel)) return;
      ipcMain.removeHandler(operation.channel);
    };
  }

  listen<TInput>(command: DesktopIpcCommand<TInput>): () => void {
    this.assertRegisterable(command.channel);
    const listener = (event: IpcMainEvent, raw: unknown) => {
      void this.executeCommand(event, raw, command);
    };
    this.commandListeners.set(command.channel, listener);
    this.dependencies.ipcMain.on(command.channel, listener);
    return () => {
      const registered = this.commandListeners.get(command.channel);
      if (registered !== listener) return;
      this.commandListeners.delete(command.channel);
      this.dependencies.ipcMain.removeListener(command.channel, listener);
    };
  }

  publish<T>(
    window: BrowserWindow | null,
    channel: string,
    stream: string,
    schema: ZodType<T>,
    rawPayload: T,
  ): boolean {
    if (this.disposed || !window || window.isDestroyed()) return false;
    const clientId = this.dependencies.sessions.currentClientForWebContents(window.webContents.id);
    if (!clientId) return false;
    const parsed = schema.safeParse(rawPayload);
    if (!parsed.success) {
      const error = new DesktopBridgeError({
        code: "contract-violation",
        message: `Desktop event '${stream}' violated its output contract.`,
        retryable: false,
        details: sanitizeDetails(parsed.error),
      });
      this.dependencies.onContractViolation?.(error);
      return false;
    }
    const sequenceKey = `${clientId}\0${stream}`;
    const sequence = (this.sequences.get(sequenceKey) ?? 0) + 1;
    this.sequences.set(sequenceKey, sequence);
    const envelope: DesktopEventEnvelope<T> = {
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      bootId: this.dependencies.sessions.bootId,
      clientId,
      stream,
      sequence,
      payload: parsed.data,
    };
    const validated = desktopEventEnvelopeSchema(stream, schema).parse(envelope);
    window.webContents.send(channel, validated);
    return true;
  }

  onClientRevoked(listener: (clientId: string) => void): () => void {
    return this.dependencies.sessions.subscribeRevoked(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const channel of this.invokeChannels) this.dependencies.ipcMain.removeHandler(channel);
    this.invokeChannels.clear();
    for (const [channel, listener] of this.commandListeners) {
      this.dependencies.ipcMain.removeListener(channel, listener);
    }
    this.commandListeners.clear();
    this.sequences.clear();
    this.disposeSequenceCleanup();
    this.dependencies.sessions.dispose();
  }

  private registerHandshake(): void {
    this.assertRegisterable(DESKTOP_IPC_CHANNELS.connect);
    this.invokeChannels.add(DESKTOP_IPC_CHANNELS.connect);
    this.dependencies.ipcMain.handle(DESKTOP_IPC_CHANNELS.connect, async (event, raw) => {
      const metadata = responseMetadata(raw);
      if (metadata.protocolVersion !== DESKTOP_PROTOCOL_VERSION) {
        return this.failure(metadata.requestId, {
          code: "protocol-mismatch",
          message: "The renderer and desktop protocol versions do not match.",
          retryable: false,
        });
      }
      try {
        this.dependencies.assertTrustedSender(event);
        const request = connectRequestSchema.parse(raw);
        const value = desktopSessionInfoSchema.parse(
          this.dependencies.sessions.connect(event, request.clientId),
        );
        return this.success(request.requestId, value);
      } catch (cause) {
        const error = cause instanceof ZodError
          ? { code: "invalid-request" as const, message: "The renderer sent an invalid session request.", retryable: false, details: sanitizeDetails(cause) }
          : operationError(cause, "unauthorized");
        return this.failure(metadata.requestId, error);
      }
    });
  }

  private async invoke<TInput, TOutput>(
    event: IpcMainInvokeEvent,
    raw: unknown,
    operation: DesktopIpcOperation<TInput, TOutput>,
  ): Promise<DesktopResponseEnvelope<TOutput>> {
    const metadata = responseMetadata(raw);
    if (metadata.protocolVersion !== DESKTOP_PROTOCOL_VERSION) {
      return this.failure(metadata.requestId, {
        code: "protocol-mismatch",
        message: "The renderer and desktop protocol versions do not match.",
        retryable: false,
      });
    }
    let request: DesktopRequestEnvelope<TInput>;
    try {
      this.dependencies.assertTrustedSender(event);
      request = z.object({
        protocolVersion: z.literal(DESKTOP_PROTOCOL_VERSION),
        requestId: desktopRequestIdSchema,
        clientId: desktopClientIdSchema,
        payload: operation.input,
      }).strict().parse(raw);
    } catch (cause) {
      const error = cause instanceof ZodError
        ? { code: "invalid-request" as const, message: "The renderer sent an invalid desktop request.", retryable: false, details: sanitizeDetails(cause) }
        : operationError(cause, "unauthorized");
      return this.failure(metadata.requestId, error);
    }
    try {
      const record = this.dependencies.sessions.authorize(event, request.clientId);
      const context = this.context(event, request.clientId, request.requestId, record.controller.signal);
      const output = await operation.run(request.payload, context);
      context.assertCurrent();
      const parsed = operation.output.safeParse(output);
      if (!parsed.success) {
        const error = new DesktopBridgeError({
          code: "contract-violation",
          message: `Desktop operation '${operation.channel}' violated its output contract.`,
          retryable: false,
          details: sanitizeDetails(parsed.error),
        });
        this.dependencies.onContractViolation?.(error);
        throw error;
      }
      return this.success(request.requestId, parsed.data);
    } catch (cause) {
      if (!(cause instanceof DesktopBridgeError)) {
        this.dependencies.onUnexpectedError?.(cause, {
          channel: operation.channel,
          failureCode: operation.failureCode,
        });
      }
      return this.failure(request.requestId, operationError(cause, operation.failureCode));
    }
  }

  private async executeCommand<TInput>(
    event: IpcMainEvent,
    raw: unknown,
    command: DesktopIpcCommand<TInput>,
  ): Promise<void> {
    try {
      this.dependencies.assertTrustedSender(event);
      const request = z.object({
        protocolVersion: z.literal(DESKTOP_PROTOCOL_VERSION),
        requestId: desktopRequestIdSchema,
        clientId: desktopClientIdSchema,
        payload: command.input,
      }).strict().parse(raw);
      const record = this.dependencies.sessions.authorize(event, request.clientId);
      const context = this.context(event, request.clientId, request.requestId, record.controller.signal);
      await command.run(request.payload, context);
      context.assertCurrent();
    } catch {
      // Fire-and-forget commands fail closed. Observable state is published separately.
    }
  }

  private context(
    event: RendererIpcEvent,
    clientId: string,
    requestId: string,
    signal: AbortSignal,
  ): DesktopIpcOperationContext {
    return {
      clientId,
      requestId,
      signal,
      isCurrent: () => this.dependencies.sessions.isCurrent(event, clientId),
      assertCurrent: () => {
        this.dependencies.sessions.authorize(event, clientId);
      },
    };
  }

  private success<T>(requestId: string, value: T): DesktopResponseEnvelope<T> {
    return desktopResponseEnvelopeSchema(z.unknown()).parse({
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      requestId,
      bootId: this.dependencies.sessions.bootId,
      ok: true,
      value,
    }) as DesktopResponseEnvelope<T>;
  }

  private failure<T>(requestId: string, error: DesktopError): DesktopResponseEnvelope<T> {
    return desktopResponseEnvelopeSchema(z.unknown()).parse({
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      requestId,
      bootId: this.dependencies.sessions.bootId,
      ok: false,
      error,
    }) as DesktopResponseEnvelope<T>;
  }

  private assertRegisterable(channel: string): void {
    if (this.disposed) throw new Error("Desktop IPC router is disposed");
    if (this.invokeChannels.has(channel) || this.commandListeners.has(channel)) {
      throw new Error(`Desktop IPC channel '${channel}' is already registered`);
    }
  }
}
