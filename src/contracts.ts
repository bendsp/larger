export type Framework = "nextjs" | "vite" | "cra" | "unknown";
export type PackageManager = "pnpm" | "npm" | "yarn" | "bun" | "unknown";

export interface ProjectManifest {
  schemaVersion: 1;
  project: {
    name: string;
    root: string;
    entryRoute?: string;
    dev: {
      command: string[];
      host: string;
      preferredPort: number;
    };
    engine: {
      adapter: string;
      mode: "sandbox";
    };
  };
}

export interface ProjectRoute {
  path: string;
  file: string;
  kind: "page" | "dynamic";
}

export interface ProjectComponent {
  name: string;
  file: string;
  family: "ui" | "project";
}

export interface ProjectAsset {
  name: string;
  path: string;
  kind: "image" | "font" | "icon" | "other";
  bytes: number;
  previewUrl: string | null;
}

export interface BrandToken {
  name: string;
  value: string;
  mode: string;
  source: string;
}

export interface BrandFont {
  family: string;
  source: string;
  weights: number[];
}

export interface GitSummary {
  branch: string;
  dirtyFiles: string[];
}

export interface ProjectSummary {
  name: string;
  entryRoute: string;
  framework: Framework;
  packageManager: PackageManager;
  git: GitSummary;
  routes: ProjectRoute[];
  components: ProjectComponent[];
  assets: ProjectAsset[];
  brand: {
    tokens: BrandToken[];
    fonts: BrandFont[];
    tailwindConfig: string | null;
    shadcn: {
      detected: boolean;
      style: string | null;
      iconLibrary: string | null;
    };
  };
  truncated: {
    files: boolean;
    assets: boolean;
    css: boolean;
  };
}

export type SessionPhase =
  | "idle"
  | "preparing"
  | "starting-target"
  | "starting-adapter"
  | "ready"
  | "stopping"
  | "error";

export interface SessionLog {
  at: number;
  source: "studio" | "target" | "adapter";
  message: string;
}

export type EditorCapabilityControl = "studio" | "embedded" | "unavailable";

export interface EditorCapabilities {
  selection: EditorCapabilityControl;
  sourceNavigation: EditorCapabilityControl;
  textEditing: EditorCapabilityControl;
  styleEditing: EditorCapabilityControl;
  layoutEditing: EditorCapabilityControl;
  history: EditorCapabilityControl;
}

export interface EditorAdapterDescriptor {
  id: string;
  name: string;
  version: string;
  supports: {
    platforms: Array<"web" | "native">;
    runtimes: string[];
  };
  capabilities: EditorCapabilities;
  maxClients: number | null;
}

export interface EditorSurface {
  kind: "web-url";
  url: string;
  embedding: "native-view" | "document" | "external";
}

export interface SandboxChange {
  file: string;
  status: "modified" | "added" | "deleted";
}

export interface SessionStartOptions {
  host?: "127.0.0.1" | "localhost";
  preferredPort?: number;
}

export interface ManagedServerSnapshot {
  mode: "managed";
  configured: ProjectManifest["project"]["dev"];
  active: {
    url: string;
    command: string[];
  } | null;
}

export interface SessionSnapshot {
  phase: SessionPhase;
  adapter: EditorAdapterDescriptor;
  server: ManagedServerSnapshot;
  surface: EditorSurface | null;
  error: string | null;
  logs: SessionLog[];
  changes: SandboxChange[];
}
