import { z } from "zod";

export const DESKTOP_PROTOCOL_VERSION = 1 as const;

export const DESKTOP_IPC_CHANNELS = {
  connect: "desktop:connect",
} as const;

export const desktopErrorCodeSchema = z.enum([
  "invalid-request",
  "protocol-mismatch",
  "unauthorized",
  "stale-client",
  "stale-generation",
  "stale-revision",
  "contract-violation",
  "unavailable",
  "cancelled",
  "conflict",
  "project-operation-failed",
  "runtime-operation-failed",
  "change-operation-failed",
  "canvas-operation-failed",
  "application-operation-failed",
]);

export type DesktopErrorCode = z.infer<typeof desktopErrorCodeSchema>;

const safeErrorDetailsSchema = z.record(
  z.string().max(128),
  z.union([
    z.string().max(4096),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()])).max(100),
  ]),
);

export const desktopErrorSchema = z.object({
  code: desktopErrorCodeSchema,
  message: z.string().min(1).max(4096),
  retryable: z.boolean(),
  details: safeErrorDetailsSchema.optional(),
}).strict();

export type DesktopError = z.infer<typeof desktopErrorSchema>;

export const desktopClientIdSchema = z.string().uuid();
export const desktopRequestIdSchema = z.string().uuid();
export const desktopBootIdSchema = z.string().uuid();

export interface DesktopRequestEnvelope<T> {
  readonly protocolVersion: typeof DESKTOP_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly clientId: string;
  readonly payload: T;
}

export type DesktopResponseEnvelope<T> =
  | {
      readonly protocolVersion: typeof DESKTOP_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly bootId: string;
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly protocolVersion: typeof DESKTOP_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly bootId: string;
      readonly ok: false;
      readonly error: DesktopError;
    };

export interface DesktopEventEnvelope<T> {
  readonly protocolVersion: typeof DESKTOP_PROTOCOL_VERSION;
  readonly bootId: string;
  readonly clientId: string;
  readonly stream: string;
  readonly sequence: number;
  readonly payload: T;
}

export interface DesktopSessionInfo {
  readonly protocolVersion: typeof DESKTOP_PROTOCOL_VERSION;
  readonly bootId: string;
  readonly clientId: string;
}

export const desktopSessionInfoSchema: z.ZodType<DesktopSessionInfo> = z.object({
  protocolVersion: z.literal(DESKTOP_PROTOCOL_VERSION),
  bootId: desktopBootIdSchema,
  clientId: desktopClientIdSchema,
}).strict();

export function desktopRequestEnvelopeSchema<T>(payload: z.ZodType<T>): z.ZodType<DesktopRequestEnvelope<T>> {
  return z.object({
    protocolVersion: z.literal(DESKTOP_PROTOCOL_VERSION),
    requestId: desktopRequestIdSchema,
    clientId: desktopClientIdSchema,
    payload,
  }).strict();
}

export function desktopResponseEnvelopeSchema<T>(value: z.ZodType<T>): z.ZodType<DesktopResponseEnvelope<T>> {
  const metadata = {
    protocolVersion: z.literal(DESKTOP_PROTOCOL_VERSION),
    requestId: desktopRequestIdSchema,
    bootId: desktopBootIdSchema,
  } as const;
  return z.discriminatedUnion("ok", [
    z.object({ ...metadata, ok: z.literal(true), value }).strict(),
    z.object({ ...metadata, ok: z.literal(false), error: desktopErrorSchema }).strict(),
  ]);
}

export function desktopEventEnvelopeSchema<T>(
  stream: string,
  payload: z.ZodType<T>,
): z.ZodType<DesktopEventEnvelope<T>> {
  return z.object({
    protocolVersion: z.literal(DESKTOP_PROTOCOL_VERSION),
    bootId: desktopBootIdSchema,
    clientId: desktopClientIdSchema,
    stream: z.literal(stream),
    sequence: z.number().int().positive(),
    payload,
  }).strict();
}

export class DesktopBridgeError extends Error {
  readonly code: DesktopErrorCode;
  readonly retryable: boolean;
  readonly details?: DesktopError["details"];

  constructor(error: DesktopError) {
    super(error.message);
    this.name = error.code;
    this.code = error.code;
    this.retryable = error.retryable;
    this.details = error.details;
  }
}
