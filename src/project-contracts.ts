export const PROJECT_MANIFEST_VERSION = 2 as const;
export const PROJECT_MANIFEST_SCHEMA_URL = "https://larger.design/schemas/larger-project.schema.json" as const;
export const APPLICATION_STATE_VERSION = 1 as const;
export const PROJECT_TRUST_STORE_VERSION = 1 as const;

export type ProjectManifestVersion = typeof PROJECT_MANIFEST_VERSION;

export interface RuntimeReadiness {
  path: string;
  timeoutMs: number;
}

export interface RuntimeEnvironment {
  literals: Record<string, string>;
  inherit: string[];
  secrets: Record<string, string>;
}

export interface RuntimeProfile {
  command: string[];
  workingDirectory: string;
  dependencyRoot: string;
  host: "127.0.0.1";
  preferredPort: number;
  readiness: RuntimeReadiness;
  entryRoute: string;
  environment: RuntimeEnvironment;
  runtimeAdapter: string;
  editorAdapter: string | null;
}

export interface ProjectManifest {
  $schema?: string;
  schemaVersion: ProjectManifestVersion;
  projectId: string;
  name: string;
  defaultRuntimeProfile: string;
  runtimeProfiles: Record<string, RuntimeProfile>;
}

export interface ManifestFieldError {
  path: string;
  code:
    | "invalid_json"
    | "invalid_type"
    | "missing"
    | "unsupported_version"
    | "invalid_value"
    | "unknown_field";
  message: string;
}

export interface ProjectIdentity {
  projectId: string;
  instanceKey: string;
  canonicalPath: string;
}

export interface RecentProject extends ProjectIdentity {
  displayName: string;
  lastOpenedAt: string;
}

export interface ProjectPersonalState {
  selectedRuntimeProfile?: string;
  lastRoute?: string;
  selectedSection?: "overview" | "changes" | "components" | "design-system" | "assets" | "routes" | "canvas" | "servers";
}

export interface ApplicationState {
  schemaVersion: typeof APPLICATION_STATE_VERSION;
  recentProjects: RecentProject[];
  personalStateByInstance: Record<string, ProjectPersonalState>;
}

export interface ProjectTrustRecord extends ProjectIdentity {
  decision: "trusted" | "denied";
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTrustState {
  schemaVersion: typeof PROJECT_TRUST_STORE_VERSION;
  records: ProjectTrustRecord[];
}

export type Detection<T> =
  | { status: "detected"; value: T; evidence: string[] }
  | { status: "not-detected"; evidence: string[] }
  | { status: "ambiguous"; candidates: T[]; evidence: string[] }
  | { status: "deferred"; reason: string; evidence: string[] };

export type DetectedPackageManager = "pnpm" | "npm" | "yarn" | "bun";
export type DetectedFramework = "nextjs" | "vite" | "cra";

export interface ProjectDetection {
  canonicalPath: string;
  packageManager: Detection<DetectedPackageManager>;
  framework: Detection<DetectedFramework>;
  scripts: Detection<Record<string, string>>;
  preferredPort: Detection<number>;
  tailwind: Detection<{ configPath: string | null; packageName: string | null }>;
  shadcn: Detection<{ configPath: string; style: string | null; iconLibrary: string | null }>;
  git: Detection<{ metadataPath: string; kind: "directory" | "file" }>;
  entryRoute: Detection<string>;
  monorepo: Detection<{ markers: string[] }>;
}
