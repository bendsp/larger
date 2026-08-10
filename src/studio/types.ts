import type {
  BrandToken,
  ProjectAsset,
  ProjectComponent,
  ProjectRoute,
} from "@/contracts";

export type Workspace =
  | "components"
  | "design-system"
  | "assets"
  | "canvas"
  | "routes"
  | "servers";

export type Viewport = "desktop" | "tablet" | "mobile";

export type StudioSelection =
  | { kind: "component"; value: ProjectComponent }
  | { kind: "token"; value: BrandToken }
  | { kind: "asset"; value: ProjectAsset }
  | { kind: "route"; value: ProjectRoute }
  | { kind: "server" }
  | null;

