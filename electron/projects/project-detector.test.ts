import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { detectProject } from "./project-detector.js";

async function fixture(context: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-detect-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeFixture(root: string, relativePath: string, contents = ""): Promise<void> {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

test("passively detects a Next, pnpm, Tailwind, ShadCN and Git project", async (context) => {
  const root = await fixture(context);
  await writeFixture(root, "package.json", JSON.stringify({
    packageManager: "pnpm@10.0.0",
    scripts: { dev: "next dev --port 3100", lint: "eslint ." },
    dependencies: { next: "15.0.0", tailwindcss: "4.0.0" },
  }));
  await writeFixture(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'");
  await writeFixture(root, "app/page.tsx", "export default function Page() { return null }");
  await writeFixture(root, "src/app/globals.css", '@import "tailwindcss";');
  await writeFixture(root, "components.json", JSON.stringify({ style: "new-york", iconLibrary: "lucide" }));
  await writeFixture(root, ".git", "gitdir: /tmp/example.git/worktrees/example");

  const result = await detectProject(root);
  assert.deepEqual(result.packageManager, {
    status: "detected",
    value: "pnpm",
    evidence: ["package.json#packageManager=pnpm@10.0.0", "pnpm-lock.yaml"],
  });
  assert.equal(result.framework.status === "detected" && result.framework.value, "nextjs");
  assert.equal(result.scripts.status === "detected" && result.scripts.value.dev, "next dev --port 3100");
  assert.equal(result.preferredPort.status === "detected" && result.preferredPort.value, 3100);
  assert.equal(result.tailwind.status, "detected");
  assert.deepEqual(result.shadcn.status === "detected" && result.shadcn.value, {
    configPath: "components.json",
    style: "new-york",
    iconLibrary: "lucide",
  });
  assert.deepEqual(result.git.status === "detected" && result.git.value, { metadataPath: ".git", kind: "file" });
  assert.equal(result.entryRoute.status === "detected" && result.entryRoute.value, "/");
  assert.equal(result.monorepo.status, "not-detected");
});

test("reports ambiguity instead of guessing conflicting signals", async (context) => {
  const root = await fixture(context);
  await writeFixture(root, "package.json", JSON.stringify({
    scripts: { first: "vite --port 3100", second: "next dev -p 3200" },
    dependencies: { next: "15.0.0", vite: "7.0.0" },
  }));
  await writeFixture(root, "pnpm-lock.yaml");
  await writeFixture(root, "yarn.lock");
  const result = await detectProject(root);
  assert.deepEqual(result.packageManager.status === "ambiguous" && result.packageManager.candidates, ["pnpm", "yarn"]);
  assert.deepEqual(result.framework.status === "ambiguous" && result.framework.candidates, ["nextjs", "vite"]);
  assert.deepEqual(result.preferredPort.status === "ambiguous" && result.preferredPort.candidates, [3100, 3200]);
  assert.equal(result.entryRoute.status, "deferred");
});

test("defers package selection and entry route discovery for monorepos", async (context) => {
  const root = await fixture(context);
  await writeFixture(root, "package.json", JSON.stringify({ workspaces: ["apps/*"], scripts: { dev: "turbo dev" } }));
  await writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
  const result = await detectProject(root);
  assert.equal(result.monorepo.status, "deferred");
  assert.deepEqual(result.monorepo.evidence, ["pnpm-workspace.yaml", "package.json#workspaces"]);
  assert.equal(result.entryRoute.status, "deferred");
});

test("makes malformed optional configuration visible without crashing detection", async (context) => {
  const root = await fixture(context);
  await writeFixture(root, "package.json", "{");
  await writeFixture(root, "components.json", "{");
  const result = await detectProject(root);
  assert.equal(result.packageManager.status, "deferred");
  assert.equal(result.framework.status, "deferred");
  assert.equal(result.scripts.status, "deferred");
  assert.equal(result.shadcn.status, "deferred");
});

test("defers oversized package metadata instead of silently treating it as absent", async (context) => {
  const root = await fixture(context);
  await writeFixture(root, "package.json", " ".repeat(1_000_001));
  const result = await detectProject(root);
  assert.equal(result.packageManager.status, "deferred");
  assert.equal(result.framework.status, "deferred");
  assert.equal(result.scripts.status, "deferred");
});

test("honors an already-aborted scan before filesystem inspection", async (context) => {
  const root = await fixture(context);
  const controller = new AbortController();
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(detectProject(root, { signal: controller.signal }), /cancelled by test/);
});

test("rejects known-file symlinks that escape the project root", async (context) => {
  const root = await fixture(context);
  const outside = await fixture(context);
  const outsidePackage = path.join(outside, "package.json");
  await writeFile(outsidePackage, JSON.stringify({ scripts: { dev: "vite" } }), "utf8");
  await symlink(outsidePackage, path.join(root, "package.json"));
  await assert.rejects(detectProject(root), /escapes the project root/);
});

test("rejects replaced parent directories that lead known reads outside the project", async (context) => {
  const root = await fixture(context);
  const outside = await fixture(context);
  await writeFixture(outside, "styles.css", '@import "tailwindcss";');
  await symlink(outside, path.join(root, "src"));
  await assert.rejects(detectProject(root), /escapes the project root/);
});
