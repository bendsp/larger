import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeWorkspaceSnapshot } from "../../src/runtime-contracts";
import {
  runtimeDiscoverInputSchema,
  runtimeWorkspaceSnapshotSchema,
} from "../../src/runtime-ipc";
import { acceptsRuntimeSnapshot } from "../../src/runtime/use-runtime";

function snapshot(overrides: Partial<RuntimeWorkspaceSnapshot> = {}): RuntimeWorkspaceSnapshot {
  return {
    formatVersion: 1,
    revision: 1,
    projectGeneration: 3,
    projectInstanceKey: "project-instance",
    profiles: [{
      name: "dev",
      command: ["pnpm", "dev"],
      workingDirectory: ".",
      host: "127.0.0.1",
      preferredPort: 3000,
      readinessPath: "/",
      runtimeAdapter: "command",
      editorAdapter: "react-rewrite",
    }],
    phase: "idle",
    operation: null,
    session: null,
    discovery: null,
    logWindow: {
      entries: [],
      earliestId: null,
      latestId: null,
      retained: 0,
      limit: 500,
      truncated: false,
    },
    problem: null,
    ...overrides,
  };
}

test("runtime discovery input is strict and revision-bound", () => {
  assert.deepEqual(runtimeDiscoverInputSchema.parse({ generation: 3, expectedRevision: 8 }), {
    generation: 3,
    expectedRevision: 8,
  });
  assert.equal(runtimeDiscoverInputSchema.safeParse({
    generation: 3,
    expectedRevision: 8,
    requestId: crypto.randomUUID(),
  }).success, false);
});

test("runtime snapshot validation enforces attached preview-only and matching project identity", () => {
  const attached = snapshot({
    phase: "ready-attached",
    session: {
      id: crypto.randomUUID(),
      projectGeneration: 3,
      projectInstanceKey: "project-instance",
      endpoint: {
        origin: "http://127.0.0.1:3000",
        route: "/",
        displayUrl: "http://127.0.0.1:3000/",
        portAllocation: null,
      },
      surface: { id: crypto.randomUUID(), editorAdapter: null, preview: true, writable: false },
      startedAt: new Date().toISOString(),
      mode: "attached",
      ownership: "external",
      profileName: null,
      target: null,
      editor: null,
      canStop: false,
      canRestart: false,
    },
  });
  assert.equal(runtimeWorkspaceSnapshotSchema.safeParse(attached).success, true);
  assert.equal(runtimeWorkspaceSnapshotSchema.safeParse({
    ...attached,
    session: { ...attached.session, surface: { ...attached.session!.surface, writable: true } },
  }).success, false);
  assert.equal(runtimeWorkspaceSnapshotSchema.safeParse({
    ...attached,
    session: { ...attached.session, projectInstanceKey: "another-project" },
  }).success, false);
});

test("runtime snapshot validation rejects inconsistent bounded log metadata", () => {
  assert.equal(runtimeWorkspaceSnapshotSchema.safeParse(snapshot({
    logWindow: {
      entries: [{
        id: 1,
        timestamp: new Date().toISOString(),
        source: "runtime",
        stream: "stdout",
        message: "ready",
      }],
      earliestId: null,
      latestId: null,
      retained: 1,
      limit: 1,
      truncated: false,
    },
  })).success, false);
});

test("renderer accepts only newer snapshots for the active project instance", () => {
  const current = snapshot({ revision: 4 });
  const state = { projectGeneration: 3, projectInstanceKey: "project-instance", snapshot: current };
  assert.equal(acceptsRuntimeSnapshot(state, snapshot({ revision: 5 })), true);
  assert.equal(acceptsRuntimeSnapshot(state, snapshot({ revision: 4 })), false);
  assert.equal(acceptsRuntimeSnapshot(state, snapshot({ revision: 5, projectGeneration: 4 })), false);
  assert.equal(acceptsRuntimeSnapshot(state, snapshot({ revision: 5, projectInstanceKey: "replacement" })), false);
  assert.equal(acceptsRuntimeSnapshot(state, snapshot({
    revision: 4,
    logWindow: {
      entries: [{
        id: 1,
        timestamp: new Date().toISOString(),
        source: "runtime",
        stream: "stdout",
        message: "after ready",
      }],
      earliestId: 1,
      latestId: 1,
      retained: 1,
      limit: 500,
      truncated: false,
    },
  })), true);
});
