import { z } from "zod";
import type {
  RuntimeOperationResult,
  RuntimeWorkspaceSnapshot,
} from "./runtime-contracts";

export const RUNTIME_IPC_CHANNELS = {
  snapshot: "runtime:snapshot",
  getSnapshot: "runtime:get-snapshot",
  start: "runtime:start",
  attach: "runtime:attach",
  discover: "runtime:discover",
  cancel: "runtime:cancel",
  stop: "runtime:stop",
  detach: "runtime:detach",
  restart: "runtime:restart",
} as const;

export interface LargerRuntimeBridge {
  getSnapshot(generation: number): Promise<RuntimeWorkspaceSnapshot>;
  start(generation: number, profileName: string, expectedRevision: number): Promise<RuntimeOperationResult>;
  attach(generation: number, url: string, expectedRevision: number): Promise<RuntimeOperationResult>;
  discover(generation: number, expectedRevision: number): Promise<RuntimeOperationResult>;
  cancel(generation: number, operationId: string): Promise<RuntimeOperationResult>;
  stop(generation: number, sessionId: string, expectedRevision: number): Promise<RuntimeOperationResult>;
  detach(generation: number, sessionId: string, expectedRevision: number): Promise<RuntimeOperationResult>;
  restart(generation: number, sessionId: string, expectedRevision: number): Promise<RuntimeOperationResult>;
  onSnapshot(listener: (snapshot: RuntimeWorkspaceSnapshot) => void): () => void;
}

const isoDateSchema = z.string().datetime();
const identifierSchema = z.string().min(1).max(512);
const portSchema = z.number().int().min(1).max(65_535);

const processIdentitySchema = z.object({
  pid: z.number().int().positive(),
  executable: z.string().min(1).max(4_096),
  startedAt: isoDateSchema,
  processGroupId: z.number().int().positive().nullable(),
}).strict();

const portAllocationSchema = z.object({
  preferred: portSchema,
  actual: portSchema,
}).strict();

const endpointSchema = z.object({
  origin: z.string().url().max(2_048),
  route: z.string().startsWith("/").max(2_048),
  displayUrl: z.string().url().max(4_096),
  portAllocation: portAllocationSchema.nullable(),
}).strict();

const surfaceSchema = z.object({
  id: z.string().uuid(),
  editorAdapter: z.string().min(1).max(128).nullable(),
  preview: z.literal(true),
  writable: z.boolean(),
}).strict();

const attachedSurfaceSchema = z.object({
  id: z.string().uuid(),
  editorAdapter: z.null(),
  preview: z.literal(true),
  writable: z.literal(false),
}).strict();

const sessionBase = {
  id: z.string().uuid(),
  projectGeneration: z.number().int().nonnegative(),
  projectInstanceKey: identifierSchema,
  endpoint: endpointSchema,
  surface: surfaceSchema,
  startedAt: isoDateSchema,
};

const sessionSchema = z.discriminatedUnion("mode", [
  z.object({
    ...sessionBase,
    mode: z.literal("managed"),
    ownership: z.literal("larger"),
    profileName: z.string().min(1).max(64),
    runtimeId: identifierSchema,
    baselineIdentity: identifierSchema,
    dependencyIdentity: identifierSchema.nullable(),
    command: z.array(z.string().max(4_096)).min(1).max(256),
    target: processIdentitySchema,
    editor: processIdentitySchema.nullable(),
    canStop: z.literal(true),
    canRestart: z.literal(true),
  }).strict(),
  z.object({
    ...sessionBase,
    surface: attachedSurfaceSchema,
    mode: z.literal("attached"),
    ownership: z.literal("external"),
    profileName: z.null(),
    target: z.null(),
    editor: z.null(),
    canStop: z.literal(false),
    canRestart: z.literal(false),
  }).strict(),
]);

const phaseSchema = z.enum([
  "idle",
  "recovering",
  "preparing-workspace",
  "preparing-dependencies",
  "allocating-port",
  "starting-target",
  "waiting-target",
  "starting-editor",
  "verifying-editor",
  "validating-attach",
  "ready-managed",
  "ready-attached",
  "stopping",
  "cancelling",
  "cancelled",
  "failed",
]);

const profileSchema = z.object({
  name: z.string().min(1).max(64),
  command: z.array(z.string().max(4_096)).min(1).max(256),
  workingDirectory: z.string().min(1).max(4_096),
  host: z.literal("127.0.0.1"),
  preferredPort: portSchema,
  readinessPath: z.string().startsWith("/").max(2_048),
  runtimeAdapter: z.string().min(1).max(128),
  editorAdapter: z.string().min(1).max(128).nullable(),
}).strict();

const discoveryCandidateSchema = z.object({
  id: identifierSchema,
  url: z.string().url().max(2_048),
  processId: z.number().int().positive().nullable(),
  label: z.string().min(1).max(256),
}).strict();

const discoverySchema = z.object({
  requestId: z.string().uuid(),
  completedAt: isoDateSchema,
  candidates: z.array(discoveryCandidateSchema).max(256),
}).strict();

const logEntrySchema = z.object({
  id: z.number().int().nonnegative(),
  timestamp: isoDateSchema,
  source: z.enum(["runtime", "editor", "system"]),
  stream: z.enum(["stdout", "stderr", "diagnostic"]),
  message: z.string().max(65_536),
}).strict();

const logWindowSchema = z.object({
  entries: z.array(logEntrySchema).max(2_000),
  earliestId: z.number().int().nonnegative().nullable(),
  latestId: z.number().int().nonnegative().nullable(),
  retained: z.number().int().nonnegative().max(2_000),
  limit: z.number().int().positive().max(2_000),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.entries.length > value.limit || value.retained > value.limit) {
    context.addIssue({ code: "custom", message: "Runtime log window exceeds its declared limit" });
  }
  if (value.entries.length === 0 && (value.earliestId !== null || value.latestId !== null)) {
    context.addIssue({ code: "custom", message: "An empty runtime log window cannot declare entry identifiers" });
  }
  if (value.entries.length > 0 && (value.earliestId === null || value.latestId === null)) {
    context.addIssue({ code: "custom", message: "A populated runtime log window must declare entry identifiers" });
  }
});

const problemSchema = z.object({
  code: z.enum([
    "no-active-project",
    "project-not-trusted",
    "stale-generation",
    "stale-revision",
    "profile-not-found",
    "workspace-failed",
    "dependencies-failed",
    "unsupported-platform",
    "unsupported-runtime",
    "port-unavailable",
    "readiness-failed",
    "editor-security-failed",
    "invalid-attach-url",
    "ownership-unknown",
    "not-owned",
    "operation-conflict",
    "internal",
  ]),
  message: z.string().min(1).max(8_192),
  recoverable: z.boolean(),
  phase: phaseSchema,
  actions: z.array(z.enum(["retry", "stop", "detach", "open-settings"])).max(4),
}).strict();

export const runtimeWorkspaceSnapshotSchema: z.ZodType<RuntimeWorkspaceSnapshot> = z.object({
  formatVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  projectGeneration: z.number().int().nonnegative().nullable(),
  projectInstanceKey: identifierSchema.nullable(),
  profiles: z.array(profileSchema).max(128),
  phase: phaseSchema,
  operation: z.object({
    id: z.string().uuid(),
    kind: z.enum(["start", "attach", "discover", "restart", "stop", "detach", "cancel", "recover"]),
    phase: phaseSchema,
    startedAt: isoDateSchema,
    cancellable: z.boolean(),
  }).strict().nullable(),
  session: sessionSchema.nullable(),
  discovery: discoverySchema.nullable(),
  logWindow: logWindowSchema,
  problem: problemSchema.nullable(),
}).strict().superRefine((value, context) => {
  const hasProjectGeneration = value.projectGeneration !== null;
  const hasProjectInstance = value.projectInstanceKey !== null;
  if (hasProjectGeneration !== hasProjectInstance) {
    context.addIssue({ code: "custom", message: "Runtime snapshots must identify either one project or no project" });
  }
  if (value.session && (
    value.session.projectGeneration !== value.projectGeneration
    || value.session.projectInstanceKey !== value.projectInstanceKey
  )) {
    context.addIssue({ code: "custom", message: "Runtime session identity does not match its workspace snapshot" });
  }
});

export const runtimeOperationResultSchema: z.ZodType<RuntimeOperationResult> = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), snapshot: runtimeWorkspaceSnapshotSchema }).strict(),
  z.object({ status: z.literal("cancelled"), snapshot: runtimeWorkspaceSnapshotSchema }).strict(),
]);

export const runtimeGenerationInputSchema = z.object({ generation: z.number().int().nonnegative() }).strict();

export const runtimeStartInputSchema = z.object({
  generation: z.number().int().nonnegative(),
  profileName: z.string().min(1).max(64),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export const runtimeAttachInputSchema = z.object({
  generation: z.number().int().nonnegative(),
  url: z.string().min(1).max(2_048),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export const runtimeDiscoverInputSchema = z.object({
  generation: z.number().int().nonnegative(),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export const runtimeCancelInputSchema = z.object({
  generation: z.number().int().nonnegative(),
  operationId: z.string().uuid(),
}).strict();

export const runtimeSessionMutationInputSchema = z.object({
  generation: z.number().int().nonnegative(),
  sessionId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
}).strict();
