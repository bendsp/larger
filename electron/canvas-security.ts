export function resolveCanvasNavigation(surfaceUrl: string, allowedOrigin: string, route: string): string {
  if (!route.startsWith("/") || route.startsWith("//") || route.includes("\\") || route.length > 2_048) {
    throw new Error("Canvas navigation requires a safe project-relative route");
  }
  const surface = new URL(surfaceUrl);
  const candidate = new URL(route, `${surface.origin}/`);
  if (surface.origin !== allowedOrigin || candidate.origin !== allowedOrigin) {
    throw new Error("Canvas navigation must stay on the active project origin");
  }
  return candidate.toString();
}
