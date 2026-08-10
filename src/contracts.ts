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
      adapter: "react-rewrite";
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
  upstream: string | null;
  dirtyFiles: string[];
}

export interface ProjectSummary {
  name: string;
  root: string;
  entryRoute: string;
  framework: Framework;
  packageManager: PackageManager;
  packageName: string;
  git: GitSummary;
  routes: ProjectRoute[];
  components: ProjectComponent[];
  assets: ProjectAsset[];
  brand: {
    tokens: BrandToken[];
    fonts: BrandFont[];
    cssFiles: string[];
    tailwindConfig: string | null;
    shadcn: {
      detected: boolean;
      style: string | null;
      baseColor: string | null;
      iconLibrary: string | null;
    };
  };
}

export type SessionPhase =
  | "idle"
  | "preparing"
  | "starting-target"
  | "starting-engine"
  | "ready"
  | "stopping"
  | "error";

export interface SessionLog {
  at: number;
  source: "studio" | "target" | "engine";
  message: string;
}

export interface SandboxChange {
  file: string;
  status: "modified" | "added" | "deleted";
}

export interface SessionSnapshot {
  phase: SessionPhase;
  targetUrl: string | null;
  proxyUrl: string | null;
  websocketUrl: string | null;
  sourceRoot: string;
  runtimeRoot: string | null;
  isolation: "sandbox";
  engine: "react-rewrite";
  engineVersion: string;
  startedAt: number | null;
  error: string | null;
  logs: SessionLog[];
  changes: SandboxChange[];
}
