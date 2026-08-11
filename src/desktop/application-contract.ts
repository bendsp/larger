import { z } from "zod";
import {
  DESKTOP_PROTOCOL_VERSION,
  desktopBootIdSchema,
  desktopErrorSchema,
  type DesktopError,
} from "./protocol";

export const APPLICATION_IPC_CHANNELS = {
  snapshot: "application:snapshot",
  getSnapshot: "application:get-snapshot",
  retry: "application:retry",
  quit: "application:quit",
} as const;

export const APPLICATION_SNAPSHOT_FORMAT_VERSION = 1 as const;

export const applicationPhaseSchema = z.enum([
  "starting",
  "recovering",
  "ready",
  "degraded",
  "shutting-down",
  "unavailable",
]);

export type ApplicationPhase = z.infer<typeof applicationPhaseSchema>;

export const applicationServiceNameSchema = z.enum([
  "projects",
  "workspaces",
  "changes",
  "runtime",
  "editor",
]);

export type ApplicationServiceName = z.infer<typeof applicationServiceNameSchema>;

export interface ApplicationServiceStatus {
  readonly status: "pending" | "ready" | "degraded" | "unavailable";
  readonly problem: DesktopError | null;
}

export interface ApplicationSnapshot {
  readonly formatVersion: typeof APPLICATION_SNAPSHOT_FORMAT_VERSION;
  readonly protocolVersion: typeof DESKTOP_PROTOCOL_VERSION;
  readonly bootId: string;
  readonly revision: number;
  readonly phase: ApplicationPhase;
  readonly services: Record<ApplicationServiceName, ApplicationServiceStatus>;
  readonly problem: DesktopError | null;
}

const applicationServiceStatusSchema: z.ZodType<ApplicationServiceStatus> = z.object({
  status: z.enum(["pending", "ready", "degraded", "unavailable"]),
  problem: desktopErrorSchema.nullable(),
}).strict();

export const applicationSnapshotSchema: z.ZodType<ApplicationSnapshot> = z.object({
  formatVersion: z.literal(APPLICATION_SNAPSHOT_FORMAT_VERSION),
  protocolVersion: z.literal(DESKTOP_PROTOCOL_VERSION),
  bootId: desktopBootIdSchema,
  revision: z.number().int().nonnegative(),
  phase: applicationPhaseSchema,
  services: z.object({
    projects: applicationServiceStatusSchema,
    workspaces: applicationServiceStatusSchema,
    changes: applicationServiceStatusSchema,
    runtime: applicationServiceStatusSchema,
    editor: applicationServiceStatusSchema,
  }).strict(),
  problem: desktopErrorSchema.nullable(),
}).strict();

export const applicationVoidSchema = z.object({}).strict();

export interface LargerApplicationBridge {
  getSnapshot(): Promise<ApplicationSnapshot>;
  retry(): Promise<ApplicationSnapshot>;
  quit(): Promise<void>;
  onSnapshot(listener: (snapshot: ApplicationSnapshot) => void): () => void;
}
