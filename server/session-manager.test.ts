import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectManifest } from "../src/contracts.js";
import type { EditorAdapterFactory } from "./editor-adapter.js";
import { resolveServerLaunch, SessionManager } from "./session-manager.js";

const manifest: ProjectManifest = {
  schemaVersion: 1,
  project: {
    name: "fixture",
    root: "../fixture",
    dev: {
      command: ["npm", "run", "dev"],
      host: "127.0.0.1",
      preferredPort: 3100,
    },
    engine: {
      adapter: "fixture-adapter",
      mode: "sandbox",
    },
  },
};

test("session state exposes only normalized data from an injected adapter", async () => {
  const createAdapter: EditorAdapterFactory = () => ({
    descriptor: {
      id: "fixture-adapter",
      name: "Fixture Adapter",
      version: "1.0.0",
      supports: { platforms: ["native"], runtimes: ["fixture"] },
      capabilities: {
        selection: "studio",
        sourceNavigation: "studio",
        textEditing: "studio",
        styleEditing: "unavailable",
        layoutEditing: "unavailable",
        history: "studio",
      },
      maxClients: null,
    },
    start: async () => ({
      kind: "web-url",
      url: "http://127.0.0.1:4567",
      embedding: "external",
    }),
    stop: async () => undefined,
  });

  const snapshot = await new SessionManager(manifest, "/unused/source", createAdapter).snapshot();
  assert.equal(snapshot.adapter.id, "fixture-adapter");
  assert.equal(snapshot.adapter.capabilities.selection, "studio");
  assert.deepEqual(snapshot.server.configured, manifest.project.dev);
  assert.equal(snapshot.server.activeUrl, null);
  assert.equal(snapshot.surface, null);
  assert.equal("proxyUrl" in snapshot, false);
  assert.equal("engineVersion" in snapshot, false);
});

test("server launch options only override the loopback host and preferred port", () => {
  assert.deepEqual(
    resolveServerLaunch(manifest.project.dev, { host: "localhost", preferredPort: 4200 }),
    { ...manifest.project.dev, host: "localhost", preferredPort: 4200 },
  );
  assert.throws(
    () => resolveServerLaunch(manifest.project.dev, { host: "0.0.0.0" as "localhost" }),
    /localhost or 127\.0\.0\.1/,
  );
  assert.throws(
    () => resolveServerLaunch(manifest.project.dev, { preferredPort: 80 }),
    /between 1024 and 65535/,
  );
});
