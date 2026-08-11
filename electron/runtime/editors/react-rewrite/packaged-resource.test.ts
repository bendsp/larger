import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveReactRewriteCliPath } from "./packaged-resource.js";

async function packageFixture(root: string): Promise<{ packageJsonPath: string; cliPath: string }> {
  const packageRoot = path.join(root, "node_modules", "react-rewrite-cli");
  const packageJsonPath = path.join(packageRoot, "package.json");
  const cliPath = path.join(packageRoot, "bin", "react-rewrite.js");
  await mkdir(path.dirname(cliPath), { recursive: true });
  await writeFile(packageJsonPath, "{}\n");
  await writeFile(cliPath, "export {};\n");
  return { packageJsonPath, cliPath };
}

test("React Rewrite resource resolves a canonical development package file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-react-rewrite-resource-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await packageFixture(root);
  assert.equal(resolveReactRewriteCliPath({ packageJsonPath: fixture.packageJsonPath }), await realpath(fixture.cliPath));
});

test("React Rewrite resource rejects a development symlink escape", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-react-rewrite-resource-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await packageFixture(root);
  const outside = path.join(root, "outside.mjs");
  await writeFile(outside, "export {};\n");
  await rm(fixture.cliPath);
  await symlink(outside, fixture.cliPath);
  assert.throws(() => resolveReactRewriteCliPath({ packageJsonPath: fixture.packageJsonPath }), /escapes|regular/);
});

test("React Rewrite resource accepts only the packaged app.asar under resources", () => {
  const resourcesPath = path.join(path.sep, "Applications", "Larger.app", "Contents", "Resources");
  const packageJsonPath = path.join(resourcesPath, "app.asar", "node_modules", "react-rewrite-cli", "package.json");
  assert.equal(
    resolveReactRewriteCliPath({ packageJsonPath, resourcesPath }),
    path.join(resourcesPath, "app.asar", "node_modules", "react-rewrite-cli", "bin", "react-rewrite.js"),
  );
  assert.throws(() => resolveReactRewriteCliPath({
    packageJsonPath,
    resourcesPath: path.join(path.sep, "different", "Resources"),
  }), /escapes/);
});
