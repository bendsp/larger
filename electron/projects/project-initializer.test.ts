import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROJECT_MANIFEST_SCHEMA_URL } from "../../src/project-contracts.js";
import { detectProject } from "./project-detector.js";
import { initializeProject, suggestProjectManifest, updateProjectManifest } from "./project-initializer.js";
import { readProjectManifest } from "./project-manifest.js";

test("initialization publishes only documented files and preserves existing repository bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-initialize-"));
  t.after(async () => (await import("node:fs/promises")).rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "dirty.txt"), "keep me exactly\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite --port 4567" }, devDependencies: { vite: "1" } }));
  await mkdir(path.join(root, ".larger"));
  await writeFile(path.join(root, ".larger", "notes.md"), "also keep me\n");

  const detection = await detectProject(root);
  const manifest = suggestProjectManifest(root, detection, () => "fixed-id");
  const publishedSchema = JSON.parse(await readFile(path.resolve("schemas/larger-project.schema.json"), "utf8")) as { $id: string };
  assert.equal(manifest.$schema, PROJECT_MANIFEST_SCHEMA_URL);
  assert.equal(manifest.$schema, publishedSchema.$id);
  await initializeProject(root, manifest);

  assert.equal(await readFile(path.join(root, "dirty.txt"), "utf8"), "keep me exactly\n");
  assert.equal(await readFile(path.join(root, ".larger", "notes.md"), "utf8"), "also keep me\n");
  assert.deepEqual((await readdir(path.join(root, ".larger"))).sort(), [".gitignore", "notes.md", "project.json"]);
  assert.deepEqual(await readProjectManifest(root), manifest);
  assert.equal((await readFile(path.join(root, ".larger", ".gitignore"), "utf8")).includes("runtime/"), true);
});

test("initialization never replaces an existing manifest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-initialize-existing-"));
  t.after(async () => (await import("node:fs/promises")).rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".larger"));
  await writeFile(path.join(root, ".larger", "project.json"), "existing bytes\n");
  const detection = await detectProject(root);
  const manifest = suggestProjectManifest(root, detection, () => "fixed-id");
  await assert.rejects(initializeProject(root, manifest), /already initialized/);
  assert.equal(await readFile(path.join(root, ".larger", "project.json"), "utf8"), "existing bytes\n");
});

test("initialization rejects an escaping metadata symlink", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-initialize-link-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "larger-initialize-outside-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await symlink(outside, path.join(root, ".larger"), "dir");
  const detection = await detectProject(root);
  const manifest = suggestProjectManifest(root, detection, () => "fixed-id");
  await assert.rejects(initializeProject(root, manifest), /symbolic link/);
  assert.deepEqual(await readdir(outside), []);
});

test("project settings update atomically replaces only the manifest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-update-manifest-"));
  t.after(async () => (await import("node:fs/promises")).rm(root, { recursive: true, force: true }));
  const detection = await detectProject(root);
  const initial = suggestProjectManifest(root, detection, () => "fixed-id");
  await initializeProject(root, initial);
  const updated = { ...initial, name: "Updated name" };
  await updateProjectManifest(root, updated);
  assert.deepEqual(await readProjectManifest(root), updated);
  assert.deepEqual((await readdir(path.join(root, ".larger"))).sort(), [".gitignore", "project.json"]);
});
