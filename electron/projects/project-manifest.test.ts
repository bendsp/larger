import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizeProjectManifest,
  parseProjectManifest,
  readProjectManifest,
  ProjectManifestValidationError,
  runSequentialManifestMigrations,
  serializeProjectManifest,
} from "./project-manifest.js";

const validManifest = {
  schemaVersion: 1,
  projectId: "larger.test-project",
  name: " Test project ",
  defaultRuntimeProfile: "development",
  runtimeProfiles: {
    production: {
      command: ["pnpm", "start"],
      workingDirectory: "./apps/web/",
      host: "localhost",
      preferredPort: 4100,
      entryRoute: "/preview",
      editorAdapter: "react-rewrite",
    },
    development: {
      command: ["pnpm", "dev"],
      workingDirectory: ".",
      host: "127.0.0.1",
      preferredPort: 3100,
      entryRoute: "/",
      editorAdapter: "react-rewrite",
    },
  },
};

test("normalizes and deterministically serializes a project manifest", () => {
  const normalized = normalizeProjectManifest(validManifest);
  assert.equal(normalized.name, "Test project");
  assert.equal(normalized.runtimeProfiles.production?.workingDirectory, "apps/web");
  assert.deepEqual(Object.keys(normalized.runtimeProfiles), ["development", "production"]);
  const first = serializeProjectManifest(normalized);
  const second = serializeProjectManifest(parseProjectManifest(first));
  assert.equal(first, second);
  assert.ok(first.indexOf('"development"') < first.indexOf('"production"'));
});

test("reports all actionable field errors with JSON-pointer paths", () => {
  const invalid = {
    ...validManifest,
    extra: true,
    projectId: "no spaces allowed",
    defaultRuntimeProfile: "missing",
    runtimeProfiles: {
      development: {
        ...validManifest.runtimeProfiles.development,
        workingDirectory: "../outside",
        command: ["pnpm", "API_KEY=should-not-live-here", "GH_TOKEN=also-secret", "--token", "dev"],
        unexpected: true,
      },
    },
  };
  assert.throws(
    () => normalizeProjectManifest(invalid),
    (cause) => {
      assert.ok(cause instanceof ProjectManifestValidationError);
      const paths = cause.errors.map(({ path }) => path);
      assert.ok(paths.includes("/extra"));
      assert.ok(paths.includes("/projectId"));
      assert.ok(paths.includes("/defaultRuntimeProfile"));
      assert.ok(paths.includes("/runtimeProfiles/development/workingDirectory"));
      assert.ok(paths.includes("/runtimeProfiles/development/command/1"));
      assert.ok(paths.includes("/runtimeProfiles/development/command/2"));
      assert.ok(paths.includes("/runtimeProfiles/development/unexpected"));
      return true;
    },
  );
});

test("published schema and application reject the same secret command arguments", async () => {
  const schema = JSON.parse(await readFile(path.resolve("schemas/larger-project.schema.json"), "utf8")) as {
    $defs: { commandArgument: { not: { anyOf: Array<{ pattern: string }> } } };
  };
  const schemaPatterns = schema.$defs.commandArgument.not.anyOf.map(({ pattern }) => new RegExp(pattern));
  const cases = [
    ["API_KEY=value", true],
    ["GH_TOKEN=value", true],
    ["mytoken=value", true],
    ["PRIVATE_KEY_SUFFIX=value", true],
    ["--token", true],
    ["--Api_Key=value", true],
    ["tokenish", false],
    ["--tokenizer", false],
    ["FOO=TOKEN", false],
  ] as const;

  for (const [argument, shouldReject] of cases) {
    const schemaRejects = schemaPatterns.some((pattern) => pattern.test(argument));
    let applicationRejects = false;
    try {
      normalizeProjectManifest({
        ...validManifest,
        runtimeProfiles: {
          ...validManifest.runtimeProfiles,
          development: { ...validManifest.runtimeProfiles.development, command: ["pnpm", argument] },
        },
      });
    } catch (cause) {
      if (!(cause instanceof ProjectManifestValidationError)) throw cause;
      applicationRejects = cause.errors.some(({ path: errorPath }) => errorPath === "/runtimeProfiles/development/command/1");
    }
    assert.equal(schemaRejects, shouldReject, `schema classification for ${argument}`);
    assert.equal(applicationRejects, shouldReject, `application classification for ${argument}`);
  }
});

test("wraps malformed JSON as a structured validation error", () => {
  assert.throws(
    () => parseProjectManifest("{"),
    (cause) => cause instanceof ProjectManifestValidationError
      && cause.errors[0]?.code === "invalid_json"
      && cause.errors[0].path === "/",
  );
});

test("runs migration hooks one schema version at a time", () => {
  const migrated = runSequentialManifestMigrations(
    { schemaVersion: 0, legacyName: "Example" },
    { 0: (value) => ({ schemaVersion: 1, name: value.legacyName }) },
  );
  assert.deepEqual(migrated, { schemaVersion: 1, name: "Example" });
  assert.throws(
    () => runSequentialManifestMigrations({ schemaVersion: 0 }),
    (cause) => cause instanceof ProjectManifestValidationError && cause.errors[0]?.code === "unsupported_version",
  );
});

test("rejects future manifest versions without silently downgrading", () => {
  assert.throws(
    () => normalizeProjectManifest({ ...validManifest, schemaVersion: 2 }),
    (cause) => cause instanceof ProjectManifestValidationError && cause.errors[0]?.code === "unsupported_version",
  );
});

test("reads the project-owned .larger/project.json location", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-manifest-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".larger"));
  await writeFile(path.join(root, ".larger", "project.json"), serializeProjectManifest(normalizeProjectManifest(validManifest)), "utf8");
  assert.equal((await readProjectManifest(root)).projectId, "larger.test-project");
});

test("rejects a project manifest symlink that escapes the project root", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "larger-manifest-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "larger-manifest-outside-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(root, ".larger"));
  const outsideManifest = path.join(outside, "project.json");
  await writeFile(outsideManifest, serializeProjectManifest(normalizeProjectManifest(validManifest)), "utf8");
  await symlink(outsideManifest, path.join(root, ".larger", "project.json"));
  await assert.rejects(readProjectManifest(root), /outside the project root/);
});
