import { extractFile, listPackage } from "@electron/asar";
import path from "node:path";
import { findPackagedApplication, packagedApplicationLayout } from "./packaged-artifact.mjs";

const REQUIRED = [
  ".larger/electron/main.cjs",
  ".larger/electron/preload.cjs",
  "dist/index.html",
  "package.json",
  "node_modules/react-rewrite-cli/package.json",
  "node_modules/react-rewrite-cli/bin/react-rewrite.js",
  "node_modules/react-rewrite-cli/dist/index.js",
];
const ALLOWED_ROOTS = [".larger/electron", "dist", "node_modules", "package.json", "LICENSE"];
const FORBIDDEN_ROOTS = ["electron", "server", "src", "test", "scripts", "patches"];
const FORBIDDEN_MODULE_ROOTS = [
  "node_modules/@electron-forge",
  "node_modules/@tailwindcss",
  "node_modules/@vitejs",
  "node_modules/electron",
  "node_modules/esbuild",
  "node_modules/next",
  "node_modules/playwright-core",
  "node_modules/shadcn",
  "node_modules/tailwindcss",
  "node_modules/tsx",
  "node_modules/typescript",
  "node_modules/vite",
];
const PATCH_MARKER = "ReactRewrite managed mode requires --host 127.0.0.1";

function normalizedEntry(value) {
  return value.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function under(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

export async function verifyPackagedArtifact(requestedPath) {
  const applicationPath = await findPackagedApplication(requestedPath);
  const layout = packagedApplicationLayout(applicationPath);
  const archivePath = path.join(layout.resourcesPath, "app.asar");
  const entries = listPackage(archivePath).map(normalizedEntry).filter(Boolean);
  const entrySet = new Set(entries);

  for (const required of REQUIRED) {
    if (!entrySet.has(required)) throw new Error(`Packaged application is missing required resource: ${required}`);
  }
  for (const entry of entries) {
    if (!ALLOWED_ROOTS.some((root) => under(root, entry) || under(entry, root))) {
      throw new Error(`Packaged application contains an unapproved root: ${entry}`);
    }
    if (FORBIDDEN_ROOTS.some((root) => under(root, entry))) {
      throw new Error(`Packaged application contains source-only content: ${entry}`);
    }
    if (FORBIDDEN_MODULE_ROOTS.some((root) => entry.startsWith(`${root}/`))) {
      throw new Error(`Packaged application contains a build-only module: ${entry}`);
    }
    if (entry.endsWith(".map")) throw new Error(`Packaged application contains a source map: ${entry}`);
  }

  const patchedEntrypoint = extractFile(archivePath, "node_modules/react-rewrite-cli/dist/index.js").toString("utf8");
  if (!patchedEntrypoint.includes(PATCH_MARKER)) {
    throw new Error("Packaged React Rewrite entrypoint does not contain Larger's security patch.");
  }
  const metadata = JSON.parse(extractFile(archivePath, "package.json").toString("utf8"));
  if (metadata.main !== ".larger/electron/main.cjs") {
    throw new Error("Packaged application main entry does not match the production Electron bundle.");
  }
  return { ...layout, archivePath };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const result = await verifyPackagedArtifact(process.argv[2]);
  console.log(`Verified packaged application: ${result.applicationPath}`);
}
