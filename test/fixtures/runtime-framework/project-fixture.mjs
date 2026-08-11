import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const RUNTIME_FIXTURE_HEADING = "Managed Vite fixture";
export const RUNTIME_FIXTURE_SOURCE = [
  "import React from 'react';",
  "export function App() {",
  `  return <main><h1>${RUNTIME_FIXTURE_HEADING}</h1></main>;`,
  "}",
  "",
].join("\n");

/**
 * @param {{
 *   projectPath: string,
 *   projectId: string,
 *   name: string,
 *   preferredPort: number,
 * }} options
 */
export async function writeRuntimeFrameworkProject({
  projectPath,
  projectId,
  name,
  preferredPort,
}) {
  const fixtureRoot = path.resolve("test/fixtures/runtime-framework");
  const fixturePackage = JSON.parse(
    await readFile(path.join(fixtureRoot, "package.json"), "utf8"),
  );
  await mkdir(path.join(projectPath, ".larger"), { recursive: true });
  await mkdir(path.join(projectPath, "app"), { recursive: true });
  await mkdir(path.join(projectPath, "src"), { recursive: true });
  await writeFile(path.join(projectPath, "package.json"), `${JSON.stringify({
    ...fixturePackage,
    name: projectId,
    scripts: { dev: "vite" },
  }, null, 2)}\n`);
  await writeFile(
    path.join(projectPath, "pnpm-lock.yaml"),
    await readFile(path.join(fixtureRoot, "pnpm-lock.yaml"), "utf8"),
  );
  await writeFile(path.join(projectPath, "index.html"), "<div id=\"root\"></div><script type=\"module\" src=\"/src/main.jsx\"></script>\n");
  await writeFile(path.join(projectPath, "src", "main.jsx"), [
    "import React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { App } from './App.jsx';",
    "createRoot(document.getElementById('root')).render(<App />);",
    "",
  ].join("\n"));
  await writeFile(path.join(projectPath, "src", "App.jsx"), RUNTIME_FIXTURE_SOURCE);
  await writeFile(path.join(projectPath, "draft.txt"), "intentional untracked fixture state\n");
  await writeFile(path.join(projectPath, "vite.config.js"), [
    "console.log(`approved:${process.env.LARGER_APPROVED_SECRET}`);",
    "console.log(`unapproved:${process.env.LARGER_UNAPPROVED_SECRET ?? 'missing'}`);",
    "export default {};",
    "",
  ].join("\n"));
  await writeFile(path.join(projectPath, "app", "page.js"), [
    "export default function Page() {",
    "  return <main><h1>Managed Next fixture</h1></main>;",
    "}",
    "",
  ].join("\n"));
  await writeFile(path.join(projectPath, "app", "layout.js"), [
    "export default function RootLayout({ children }) {",
    "  return <html><body>{children}</body></html>;",
    "}",
    "",
  ].join("\n"));
  await writeFile(path.join(projectPath, ".larger", "project.json"), `${JSON.stringify({
    schemaVersion: 2,
    projectId,
    name,
    defaultRuntimeProfile: "vite",
    runtimeProfiles: {
      vite: {
        command: ["pnpm", "exec", "vite", "--host", "{host}", "--port", "{port}", "--strictPort"],
        workingDirectory: ".",
        dependencyRoot: ".",
        host: "127.0.0.1",
        preferredPort,
        readiness: { path: "/", timeoutMs: 15_000 },
        entryRoute: "/",
        environment: { literals: {}, inherit: ["PATH", "LARGER_APPROVED_SECRET"], secrets: {} },
        runtimeAdapter: "command",
        editorAdapter: null,
      },
      "react-rewrite": {
        command: ["pnpm", "exec", "vite", "--host", "{host}", "--port", "{port}", "--strictPort"],
        workingDirectory: ".",
        dependencyRoot: ".",
        host: "127.0.0.1",
        preferredPort: preferredPort + 10,
        readiness: { path: "/", timeoutMs: 15_000 },
        entryRoute: "/",
        environment: { literals: {}, inherit: ["PATH"], secrets: {} },
        runtimeAdapter: "command",
        editorAdapter: "react-rewrite",
      },
      next: {
        command: ["pnpm", "exec", "next", "dev", "--hostname", "{host}", "--port", "{port}"],
        workingDirectory: ".",
        dependencyRoot: ".",
        host: "127.0.0.1",
        preferredPort: preferredPort + 20,
        readiness: { path: "/", timeoutMs: 30_000 },
        entryRoute: "/",
        environment: { literals: {}, inherit: ["PATH"], secrets: {} },
        runtimeAdapter: "command",
        editorAdapter: null,
      },
    },
  }, null, 2)}\n`);
}
