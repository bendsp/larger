import assert from "node:assert/strict";
import test from "node:test";
import {
  ProcessEnvironmentSecretProvider,
  RuntimeEnvironmentBuilder,
  type ProcessEnvironmentSource,
  type SecretProvider,
} from "./environment.js";

const source: ProcessEnvironmentSource = {
  platform: "darwin",
  get(name) {
    return { HOME: "/Users/test", PATH: "/usr/bin", AWS_SECRET_ACCESS_KEY: "ambient-secret" }[name];
  },
};

const secrets: SecretProvider = {
  async resolve(reference) {
    assert.equal(reference, "keychain://project/api");
    return "approved-secret";
  },
};

test("builds a minimal environment from essentials and explicit declarations", async () => {
  const result = await new RuntimeEnvironmentBuilder(source, secrets).build({
    literals: { NODE_ENV: "development" },
    inherit: ["PATH"],
    secrets: { API_TOKEN: "keychain://project/api" },
  });
  assert.deepEqual(result.values, {
    HOME: "/Users/test",
    PATH: "/usr/bin",
    NODE_ENV: "development",
    API_TOKEN: "approved-secret",
  });
  assert.equal("AWS_SECRET_ACCESS_KEY" in result.values, false);
  assert.deepEqual(result.secretValues, ["approved-secret"]);
});

test("PATH is part of the explicit minimal platform environment", async () => {
  const result = await new RuntimeEnvironmentBuilder(source, secrets).build({
    literals: {},
    inherit: [],
    secrets: {},
  });
  assert.equal(result.values.PATH, "/usr/bin");
  assert.equal("AWS_SECRET_ACCESS_KEY" in result.values, false);
});

test("rejects case-insensitive environment collisions on Windows", async () => {
  const windows: ProcessEnvironmentSource = { platform: "win32", get: () => undefined };
  await assert.rejects(
    new RuntimeEnvironmentBuilder(windows, secrets).build({
      literals: { Path: "a", PATH: "b" },
      inherit: [],
      secrets: {},
    }),
    /Duplicate environment variable/,
  );
});

test("treats explicitly inherited values as redaction secrets", async () => {
  const result = await new RuntimeEnvironmentBuilder(source, secrets).build({
    literals: {},
    inherit: ["AWS_SECRET_ACCESS_KEY"],
    secrets: {},
  });
  assert.deepEqual(result.secretValues, ["ambient-secret"]);
});

test("resolves explicit environment-backed secret references and rejects implicit names", async () => {
  const provider = new ProcessEnvironmentSecretProvider(source);
  assert.equal(await provider.resolve("env://AWS_SECRET_ACCESS_KEY"), "ambient-secret");
  await assert.rejects(provider.resolve("AWS_SECRET_ACCESS_KEY"), /Unsupported secret reference/);
  await assert.rejects(provider.resolve("env://MISSING"), /unavailable/);
});
