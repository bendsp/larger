import { z } from "zod";
import type {
  ManifestFieldError,
  ProjectDetection,
  ProjectIdentity,
  ProjectManifest,
  ProjectPersonalState,
  RecentProject,
} from "./project-contracts";

export const PROJECT_IPC_CHANNELS = {
  snapshot: "projects:snapshot",
  getSnapshot: "projects:get-snapshot",
  pickAndOpen: "projects:pick-and-open",
  openRecent: "projects:open-recent",
  initialize: "projects:initialize",
  updateManifest: "projects:update-manifest",
  dismissPending: "projects:dismiss-pending",
  setTrust: "projects:set-trust",
  refresh: "projects:refresh",
  close: "projects:close",
  removeRecent: "projects:remove-recent",
  updatePersonalState: "projects:update-personal-state",
  prepareWorkspace: "projects:prepare-workspace",
} as const;

export interface PreparedWorkspaceSummary {
  baselineIdentity: string;
  runtimeId: string;
  preparedAt: string;
}

export interface ActiveProject {
  generation: number;
  manifest: ProjectManifest;
  identity: ProjectIdentity;
  detection: ProjectDetection;
  trust: "trusted" | "denied" | "undecided";
  personalState: ProjectPersonalState;
  workspace: PreparedWorkspaceSummary | null;
}

export type PendingProjectReason =
  | "needs-initialization"
  | "invalid-manifest"
  | "unsupported-monorepo";

export interface PendingProject {
  generation: number;
  canonicalPath: string;
  displayName: string;
  reason: PendingProjectReason;
  detection: ProjectDetection;
  suggestedManifest: ProjectManifest | null;
  fieldErrors: ManifestFieldError[];
}

export interface ProjectProblem {
  code:
    | "cancelled"
    | "missing"
    | "unsupported"
    | "invalid-manifest"
    | "not-trusted"
    | "stale-generation"
    | "switch-blocked"
    | "workspace-failed"
    | "internal";
  message: string;
  recoverable: boolean;
  fieldErrors?: ManifestFieldError[];
}

export interface ProjectLifecycleSnapshot {
  revision: number;
  active: ActiveProject | null;
  pending: PendingProject | null;
  transition: { generation: number; kind: "opening" | "initializing" | "preparing-workspace" } | null;
  recentProjects: RecentProject[];
  problem: ProjectProblem | null;
}

export type ProjectOperationResult =
  | { status: "completed"; snapshot: ProjectLifecycleSnapshot }
  | { status: "cancelled"; snapshot: ProjectLifecycleSnapshot };

export const generationInputSchema = z.object({ generation: z.number().int().nonnegative() }).strict();
export const recentInputSchema = z.object({ instanceKey: z.string().min(1).max(256) }).strict();
export const trustInputSchema = z.object({
  generation: z.number().int().nonnegative(),
  decision: z.enum(["trusted", "denied"]),
}).strict();
export const initializeInputSchema = z.object({
  generation: z.number().int().nonnegative(),
  manifest: z.unknown(),
}).strict();
export const personalStateInputSchema = z.object({
  generation: z.number().int().nonnegative(),
  personalState: z.object({
    selectedRuntimeProfile: z.string().min(1).max(64).optional(),
    lastRoute: z.string().startsWith("/").max(2048).refine((route) => !route.startsWith("//"), {
      message: "route must not be scheme-relative",
    }).optional(),
    selectedSection: z.enum(["overview", "changes", "components", "design-system", "assets", "routes", "canvas", "servers"]).optional(),
  }).strict(),
}).strict();

export interface LargerProjectsBridge {
  getSnapshot(): Promise<ProjectLifecycleSnapshot>;
  pickAndOpen(): Promise<ProjectOperationResult>;
  openRecent(instanceKey: string): Promise<ProjectOperationResult>;
  initialize(generation: number, manifest: ProjectManifest): Promise<ProjectOperationResult>;
  updateManifest(generation: number, manifest: ProjectManifest): Promise<ProjectOperationResult>;
  dismissPending(generation: number): Promise<ProjectOperationResult>;
  setTrust(generation: number, decision: "trusted" | "denied"): Promise<ProjectOperationResult>;
  refresh(generation: number): Promise<ProjectOperationResult>;
  close(generation: number): Promise<ProjectOperationResult>;
  removeRecent(instanceKey: string): Promise<ProjectOperationResult>;
  updatePersonalState(generation: number, personalState: ProjectPersonalState): Promise<ProjectOperationResult>;
  prepareWorkspace(generation: number): Promise<ProjectOperationResult>;
  onSnapshot(listener: (snapshot: ProjectLifecycleSnapshot) => void): () => void;
}

const stringArray = z.array(z.string());
const detectionSchema = <T extends z.ZodType>(value: T) => z.discriminatedUnion("status", [
  z.object({ status: z.literal("detected"), value, evidence: stringArray }).strict(),
  z.object({ status: z.literal("not-detected"), evidence: stringArray }).strict(),
  z.object({ status: z.literal("ambiguous"), candidates: z.array(value), evidence: stringArray }).strict(),
  z.object({ status: z.literal("deferred"), reason: z.string(), evidence: stringArray }).strict(),
]);
const runtimeProfileSchema = z.object({
  command: stringArray,
  workingDirectory: z.string(),
  dependencyRoot: z.string(),
  host: z.literal("127.0.0.1"),
  preferredPort: z.number().int(),
  readiness: z.object({ path: z.string(), timeoutMs: z.number().int() }).strict(),
  entryRoute: z.string(),
  environment: z.object({
    literals: z.record(z.string(), z.string()),
    inherit: stringArray,
    secrets: z.record(z.string(), z.string()),
  }).strict(),
  runtimeAdapter: z.string(),
  editorAdapter: z.string().nullable(),
}).strict();
const manifestSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(2),
  projectId: z.string(),
  name: z.string(),
  defaultRuntimeProfile: z.string(),
  runtimeProfiles: z.record(z.string(), runtimeProfileSchema),
}).strict();
const identitySchema = z.object({ projectId: z.string(), instanceKey: z.string(), canonicalPath: z.string() }).strict();
const personalStateSchema = z.object({
  selectedRuntimeProfile: z.string().optional(),
  lastRoute: z.string().startsWith("/").refine((route) => !route.startsWith("//")).optional(),
  selectedSection: z.enum(["overview", "changes", "components", "design-system", "assets", "routes", "canvas", "servers"]).optional(),
}).strict();
const projectDetectionSchema = z.object({
  canonicalPath: z.string(),
  packageManager: detectionSchema(z.enum(["pnpm", "npm", "yarn", "bun"])),
  framework: detectionSchema(z.enum(["nextjs", "vite", "cra"])),
  scripts: detectionSchema(z.record(z.string(), z.string())),
  preferredPort: detectionSchema(z.number().int()),
  tailwind: detectionSchema(z.object({ configPath: z.string().nullable(), packageName: z.string().nullable() }).strict()),
  shadcn: detectionSchema(z.object({ configPath: z.string(), style: z.string().nullable(), iconLibrary: z.string().nullable() }).strict()),
  git: detectionSchema(z.object({ metadataPath: z.string(), kind: z.enum(["directory", "file"]) }).strict()),
  entryRoute: detectionSchema(z.string()),
  monorepo: detectionSchema(z.object({ markers: stringArray }).strict()),
}).strict();
const manifestFieldErrorSchema = z.object({
  path: z.string(),
  code: z.enum(["invalid_json", "invalid_type", "missing", "unsupported_version", "invalid_value", "unknown_field"]),
  message: z.string(),
}).strict();
const recentProjectSchema = identitySchema.extend({ displayName: z.string(), lastOpenedAt: z.string() }).strict();
const activeProjectSchema = z.object({
  generation: z.number().int().nonnegative(),
  manifest: manifestSchema,
  identity: identitySchema,
  detection: projectDetectionSchema,
  trust: z.enum(["trusted", "denied", "undecided"]),
  personalState: personalStateSchema,
  workspace: z.object({ baselineIdentity: z.string(), runtimeId: z.string(), preparedAt: z.string() }).strict().nullable(),
}).strict();
const pendingProjectSchema = z.object({
  generation: z.number().int().nonnegative(),
  canonicalPath: z.string(),
  displayName: z.string(),
  reason: z.enum(["needs-initialization", "invalid-manifest", "unsupported-monorepo"]),
  detection: projectDetectionSchema,
  suggestedManifest: manifestSchema.nullable(),
  fieldErrors: z.array(manifestFieldErrorSchema),
}).strict();
const projectProblemSchema = z.object({
  code: z.enum(["cancelled", "missing", "unsupported", "invalid-manifest", "not-trusted", "stale-generation", "switch-blocked", "workspace-failed", "internal"]),
  message: z.string(),
  recoverable: z.boolean(),
  fieldErrors: z.array(manifestFieldErrorSchema).optional(),
}).strict();

export const projectLifecycleSnapshotSchema: z.ZodType<ProjectLifecycleSnapshot> = z.object({
  revision: z.number().int().nonnegative(),
  active: activeProjectSchema.nullable(),
  pending: pendingProjectSchema.nullable(),
  transition: z.object({
    generation: z.number().int().nonnegative(),
    kind: z.enum(["opening", "initializing", "preparing-workspace"]),
  }).strict().nullable(),
  recentProjects: z.array(recentProjectSchema),
  problem: projectProblemSchema.nullable(),
}).strict();

export const projectOperationResultSchema: z.ZodType<ProjectOperationResult> = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), snapshot: projectLifecycleSnapshotSchema }).strict(),
  z.object({ status: z.literal("cancelled"), snapshot: projectLifecycleSnapshotSchema }).strict(),
]);
