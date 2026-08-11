import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow, Dialog } from "electron";
import { CHANGE_IPC_CHANNELS } from "../../src/change-ipc.js";
import { PROJECT_IPC_CHANNELS } from "../../src/project-ipc.js";
import type { ProjectManager } from "../projects/project-manager.js";
import type { DesktopIpcOperation, DesktopIpcOperationContext, DesktopIpcRouter } from "./desktop-ipc-router.js";
import { registerChangeIpc, type ChangeServicePort } from "./change-ipc.js";
import { registerProjectIpc } from "./project-ipc.js";

function routerHarness(): {
  readonly router: DesktopIpcRouter;
  readonly operations: Map<string, DesktopIpcOperation<unknown, unknown>>;
} {
  const operations = new Map<string, DesktopIpcOperation<unknown, unknown>>();
  return {
    operations,
    router: {
      register(operation: DesktopIpcOperation<unknown, unknown>) {
        operations.set(operation.channel, operation);
        return () => operations.delete(operation.channel);
      },
      publish: () => true,
    } as unknown as DesktopIpcRouter,
  };
}

function context(signal: AbortSignal): DesktopIpcOperationContext {
  return {
    clientId: "10000000-0000-4000-8000-000000000001",
    requestId: "10000000-0000-4000-8000-000000000002",
    signal,
    isCurrent: () => !signal.aborted,
    assertCurrent: () => signal.throwIfAborted(),
  };
}

test("every project mutation receives the renderer document lease", async () => {
  const { router, operations } = routerHarness();
  const observed = new Map<string, AbortSignal | undefined>();
  const completed = { status: "completed", snapshot: {} } as never;
  const manager = {
    snapshot: () => ({}),
    subscribe: () => () => undefined,
    initialize: async (_generation: number, _manifest: unknown, options?: { signal?: AbortSignal }) => { observed.set("initialize", options?.signal); return completed; },
    updateManifest: async (_generation: number, _manifest: unknown, options?: { signal?: AbortSignal }) => { observed.set("updateManifest", options?.signal); return completed; },
    dismissPending: async (_generation: number, options?: { signal?: AbortSignal }) => { observed.set("dismissPending", options?.signal); return completed; },
    setTrust: async (_generation: number, _decision: unknown, options?: { signal?: AbortSignal }) => { observed.set("setTrust", options?.signal); return completed; },
    refresh: async (_generation: number, options?: { signal?: AbortSignal }) => { observed.set("refresh", options?.signal); return completed; },
    close: async (_generation: number, options?: { signal?: AbortSignal }) => { observed.set("close", options?.signal); return completed; },
    updatePersonalState: async (_generation: number, _state: unknown, options?: { signal?: AbortSignal }) => { observed.set("updatePersonalState", options?.signal); return completed; },
    prepareWorkspace: async (_generation: number, options?: { signal?: AbortSignal }) => { observed.set("prepareWorkspace", options?.signal); return completed; },
  } as unknown as ProjectManager;
  const dispose = registerProjectIpc({
    router,
    manager,
    dialog: {} as Pick<Dialog, "showOpenDialog">,
    getWindow: () => null,
    pickAndOpen: async (lease) => { observed.set("pickAndOpen", lease.signal); return completed; },
    openRecent: async (_instanceKey, lease) => { observed.set("openRecent", lease.signal); return completed; },
    removeRecent: async (_instanceKey, lease) => { observed.set("removeRecent", lease.signal); return completed; },
  });
  const signal = new AbortController().signal;
  const lease = context(signal);
  const cases = [
    ["pickAndOpen", PROJECT_IPC_CHANNELS.pickAndOpen, {}],
    ["openRecent", PROJECT_IPC_CHANNELS.openRecent, { instanceKey: "instance" }],
    ["initialize", PROJECT_IPC_CHANNELS.initialize, { generation: 1, manifest: {} }],
    ["updateManifest", PROJECT_IPC_CHANNELS.updateManifest, { generation: 1, manifest: {} }],
    ["dismissPending", PROJECT_IPC_CHANNELS.dismissPending, { generation: 1 }],
    ["setTrust", PROJECT_IPC_CHANNELS.setTrust, { generation: 1, decision: "trusted" }],
    ["refresh", PROJECT_IPC_CHANNELS.refresh, { generation: 1 }],
    ["close", PROJECT_IPC_CHANNELS.close, { generation: 1 }],
    ["removeRecent", PROJECT_IPC_CHANNELS.removeRecent, { instanceKey: "instance" }],
    ["updatePersonalState", PROJECT_IPC_CHANNELS.updatePersonalState, { generation: 1, personalState: {} }],
    ["prepareWorkspace", PROJECT_IPC_CHANNELS.prepareWorkspace, { generation: 1 }],
  ] as const;
  for (const [name, channel, payload] of cases) {
    await operations.get(channel)!.run(payload, lease);
    assert.equal(observed.get(name), signal, `${name} must receive the renderer document lease`);
  }
  assert.deepEqual([...operations.keys()].sort(), Object.values(PROJECT_IPC_CHANNELS)
    .filter((channel) => channel !== PROJECT_IPC_CHANNELS.snapshot)
    .sort());
  dispose();
});

test("every change mutation receives the renderer document lease", async () => {
  const { router, operations } = routerHarness();
  const observed = new Map<string, AbortSignal | undefined>();
  const completed = { status: "completed", snapshot: {} } as never;
  const service: ChangeServicePort = {
    snapshot: () => ({} as never),
    scan: async (_generation, options) => { observed.set("scan", options?.signal); return completed; },
    updateSelection: async (_generation, _id, _revision, _selection, options) => { observed.set("updateSelection", options?.signal); return completed; },
    prepareApply: async (_generation, _id, _revision, options) => { observed.set("prepareApply", options?.signal); return completed; },
    commitApply: async (_generation, _id, _digest, options) => { observed.set("commitApply", options?.signal); return completed; },
    discard: async (_generation, _id, _revision, _confirm, options) => { observed.set("discard", options?.signal); return completed; },
    recover: async (_generation, _id, _action, options) => { observed.set("recover", options?.signal); return completed; },
    subscribe: () => () => undefined,
  };
  const dispose = registerChangeIpc({ router, service, getWindow: () => null as BrowserWindow | null });
  const signal = new AbortController().signal;
  const lease = context(signal);
  const cases = [
    ["scan", CHANGE_IPC_CHANNELS.scan, { generation: 1 }],
    ["updateSelection", CHANGE_IPC_CHANNELS.updateSelection, { generation: 1, changeSetId: "change", expectedRevision: 1, selection: { files: [] } }],
    ["prepareApply", CHANGE_IPC_CHANNELS.prepareApply, { generation: 1, changeSetId: "change", expectedRevision: 1 }],
    ["commitApply", CHANGE_IPC_CHANNELS.commitApply, { generation: 1, transactionId: "transaction", planDigest: "digest" }],
    ["discard", CHANGE_IPC_CHANNELS.discard, { generation: 1, changeSetId: "change", expectedRevision: 1, confirmUnappliedLoss: true }],
    ["recover", CHANGE_IPC_CHANNELS.recover, { generation: 1, transactionId: "transaction", action: "roll-back" }],
  ] as const;
  for (const [name, channel, payload] of cases) {
    await operations.get(channel)!.run(payload, lease);
    assert.equal(observed.get(name), signal, `${name} must receive the renderer document lease`);
  }
  assert.deepEqual([...operations.keys()].sort(), Object.values(CHANGE_IPC_CHANNELS)
    .filter((channel) => channel !== CHANGE_IPC_CHANNELS.snapshot)
    .sort());
  dispose();
});
