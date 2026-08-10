import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectProject, resolveProjectAsset } from "./project-inspector.js";

test("derives root routes, assets, brand weights, and shadcn metadata from files", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-inspector-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(path.join(root, "app"), { recursive: true }),
    mkdir(path.join(root, "components"), { recursive: true }),
    mkdir(path.join(root, "public"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", dependencies: { react: "19.0.0", next: "15.0.0" } })),
    writeFile(path.join(root, "next.config.js"), "module.exports = {}"),
    writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'"),
    writeFile(path.join(root, "app", "page.tsx"), "export default function Page() { return <main /> }"),
    writeFile(path.join(root, "components", "theme-toggle.tsx"), "export function ThemeToggle() { return <button>theme</button> }"),
    writeFile(path.join(root, "public", "icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" />"),
    writeFile(path.join(root, "tailwind.config.ts"), "export default {}"),
    writeFile(path.join(root, "components.json"), JSON.stringify({ style: "new-york", iconLibrary: "lucide", tailwind: { baseColor: "neutral" } })),
    writeFile(
      path.join(root, "app", "globals.css"),
      '@font-face { font-family: "Satoshi"; font-weight: 400; }\n@font-face { font-family: "Satoshi"; font-weight: 700; }\n:root { --background: #fff; }\n.dark { --background: #111; }',
    ),
  ]);

  const project = await inspectProject("fixture", root, "/about");
  assert.equal(project.entryRoute, "/about");
  assert.equal(project.framework, "nextjs");
  assert.equal(project.packageManager, "pnpm");
  assert.deepEqual(project.routes.map((route) => route.path), ["/"]);
  assert.equal(project.components[0]?.name, "ThemeToggle");
  assert.equal(project.assets[0]?.path, "public/icon.svg");
  assert.deepEqual(project.brand.fonts[0]?.weights, [400, 700]);
  assert.equal(project.brand.tokens.length, 2);
  assert.deepEqual(project.brand.shadcn, {
    detected: true,
    style: "new-york",
    baseColor: "neutral",
    iconLibrary: "lucide",
  });
});

test("rejects asset symlinks that escape the project", async (context) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "larger-asset-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  await mkdir(path.join(project, "public"), { recursive: true });
  await writeFile(path.join(base, "outside.svg"), "<svg />");
  await symlink(path.join(base, "outside.svg"), path.join(project, "public", "outside.svg"));
  await assert.rejects(resolveProjectAsset(project, "public/outside.svg"), /escapes/);
});
