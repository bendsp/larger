import assert from "node:assert/strict";
import test from "node:test";
import { z, type ZodType } from "zod";

import {
  APPLICATION_IPC_CHANNELS,
  applicationSnapshotSchema,
  applicationVoidSchema,
} from "../src/desktop/application-contract.js";
import {
  CANVAS_IPC_CHANNELS,
  canvasBoundsInputSchema,
  canvasAckSchema,
  canvasFocusReturnSchema,
  canvasNavigateInputSchema,
  canvasNavigationSchema,
  canvasSurfaceInputSchema,
} from "../src/desktop/canvas-contract.js";
import {
  CHANGE_IPC_CHANNELS,
  changeGenerationInputSchema,
  changeOperationResultSchema,
  changeSelectionInputSchema,
  changeSetMutationInputSchema,
  changeWorkspaceSnapshotSchema,
  commitApplyInputSchema,
  discardInputSchema,
  preparedApplyResultSchema,
  recoverInputSchema,
} from "../src/change-ipc.js";
import {
  PROJECT_IPC_CHANNELS,
  generationInputSchema,
  initializeInputSchema,
  personalStateInputSchema,
  projectLifecycleSnapshotSchema,
  projectOperationResultSchema,
  recentInputSchema,
  trustInputSchema,
} from "../src/project-ipc.js";
import {
  RUNTIME_IPC_CHANNELS,
  runtimeAttachInputSchema,
  runtimeCancelInputSchema,
  runtimeDiscoverInputSchema,
  runtimeGenerationInputSchema,
  runtimeOperationResultSchema,
  runtimeSessionMutationInputSchema,
  runtimeStartInputSchema,
  runtimeWorkspaceSnapshotSchema,
} from "../src/runtime-ipc.js";
import {
  createPreloadBridge,
  type LargerDesktopBridge,
  type PreloadTransport,
} from "./preload-bridge.js";

interface InvokeRecord {
  readonly channel: string;
  readonly schema: ZodType<unknown>;
  readonly payload: unknown;
}

interface SendRecord {
  readonly channel: string;
  readonly payload: unknown;
}

interface SubscriptionRecord {
  readonly channel: string;
  readonly stream: string;
  readonly schema: ZodType<unknown>;
}

class RecordingTransport implements PreloadTransport {
  readonly invokes: InvokeRecord[] = [];
  readonly sends: SendRecord[] = [];
  readonly subscriptions: SubscriptionRecord[] = [];

  constructor(private readonly rejectInvalidOutput = false) {}

  invoke<T>(channel: string, schema: ZodType<T>, payload: unknown = {}): Promise<T> {
    this.invokes.push({ channel, schema: schema as ZodType<unknown>, payload });
    if (this.rejectInvalidOutput) {
      return Promise.resolve().then(() => schema.parse(Symbol("invalid-output")));
    }
    return Promise.resolve(undefined as T);
  }

  send(channel: string, payload: unknown): void {
    this.sends.push({ channel, payload });
  }

  subscribe<T>(channel: string, stream: string, schema: ZodType<T>): () => void {
    this.subscriptions.push({ channel, stream, schema: schema as ZodType<unknown> });
    return () => undefined;
  }
}

type Namespace = keyof LargerDesktopBridge;

function call(
  bridge: LargerDesktopBridge,
  namespace: Namespace,
  methodName: string,
  args: readonly unknown[] = [],
): unknown {
  const methods = bridge[namespace] as unknown as Record<string, unknown>;
  return (methods[methodName] as (...values: unknown[]) => unknown)(...args);
}

const manifest = { manifest: "fixture" };
const personalState = { selectedSection: "overview" };
const selection = {
  files: [{
    fileId: "a".repeat(64),
    includeFile: true,
    hunkIds: ["b".repeat(64)],
  }],
};
const bounds = { x: 1, y: 2, width: 3, height: 4 };
const transactionId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const planDigest = "c".repeat(64);
const emptyInputSchema = z.object({}).strict();

const inputSchemaByChannel: Readonly<Record<string, ZodType<unknown>>> = {
  [APPLICATION_IPC_CHANNELS.getSnapshot]: emptyInputSchema,
  [APPLICATION_IPC_CHANNELS.retry]: emptyInputSchema,
  [APPLICATION_IPC_CHANNELS.quit]: emptyInputSchema,
  [PROJECT_IPC_CHANNELS.getSnapshot]: emptyInputSchema,
  [PROJECT_IPC_CHANNELS.pickAndOpen]: emptyInputSchema,
  [PROJECT_IPC_CHANNELS.openRecent]: recentInputSchema,
  [PROJECT_IPC_CHANNELS.initialize]: initializeInputSchema,
  [PROJECT_IPC_CHANNELS.updateManifest]: initializeInputSchema,
  [PROJECT_IPC_CHANNELS.dismissPending]: generationInputSchema,
  [PROJECT_IPC_CHANNELS.setTrust]: trustInputSchema,
  [PROJECT_IPC_CHANNELS.refresh]: generationInputSchema,
  [PROJECT_IPC_CHANNELS.close]: generationInputSchema,
  [PROJECT_IPC_CHANNELS.removeRecent]: recentInputSchema,
  [PROJECT_IPC_CHANNELS.updatePersonalState]: personalStateInputSchema,
  [PROJECT_IPC_CHANNELS.prepareWorkspace]: generationInputSchema,
  [CHANGE_IPC_CHANNELS.getSnapshot]: changeGenerationInputSchema,
  [CHANGE_IPC_CHANNELS.scan]: changeGenerationInputSchema,
  [CHANGE_IPC_CHANNELS.updateSelection]: changeSelectionInputSchema,
  [CHANGE_IPC_CHANNELS.prepareApply]: changeSetMutationInputSchema,
  [CHANGE_IPC_CHANNELS.commitApply]: commitApplyInputSchema,
  [CHANGE_IPC_CHANNELS.discard]: discardInputSchema,
  [CHANGE_IPC_CHANNELS.recover]: recoverInputSchema,
  [RUNTIME_IPC_CHANNELS.getSnapshot]: runtimeGenerationInputSchema,
  [RUNTIME_IPC_CHANNELS.start]: runtimeStartInputSchema,
  [RUNTIME_IPC_CHANNELS.attach]: runtimeAttachInputSchema,
  [RUNTIME_IPC_CHANNELS.discover]: runtimeDiscoverInputSchema,
  [RUNTIME_IPC_CHANNELS.cancel]: runtimeCancelInputSchema,
  [RUNTIME_IPC_CHANNELS.stop]: runtimeSessionMutationInputSchema,
  [RUNTIME_IPC_CHANNELS.detach]: runtimeSessionMutationInputSchema,
  [RUNTIME_IPC_CHANNELS.restart]: runtimeSessionMutationInputSchema,
  [CANVAS_IPC_CHANNELS.load]: canvasSurfaceInputSchema,
  [CANVAS_IPC_CHANNELS.navigate]: canvasNavigateInputSchema,
  [CANVAS_IPC_CHANNELS.bounds]: canvasBoundsInputSchema,
  [CANVAS_IPC_CHANNELS.show]: canvasSurfaceInputSchema,
  [CANVAS_IPC_CHANNELS.focus]: canvasSurfaceInputSchema,
  [CANVAS_IPC_CHANNELS.hide]: canvasSurfaceInputSchema,
};

const expectedBridgeMethods = {
  application: ["getSnapshot", "onSnapshot", "quit", "retry"],
  projects: [
    "close",
    "dismissPending",
    "getSnapshot",
    "initialize",
    "onSnapshot",
    "openRecent",
    "pickAndOpen",
    "prepareWorkspace",
    "refresh",
    "removeRecent",
    "setTrust",
    "updateManifest",
    "updatePersonalState",
  ],
  changes: ["commitApply", "discard", "getSnapshot", "onSnapshot", "prepareApply", "recover", "scan", "updateSelection"],
  runtime: ["attach", "cancel", "detach", "discover", "getSnapshot", "onSnapshot", "restart", "start", "stop"],
  canvas: ["focus", "hide", "load", "navigate", "onFocusReturn", "onNavigation", "setBounds", "show"],
} as const satisfies Record<Namespace, readonly string[]>;

const invokeCases: ReadonlyArray<{
  readonly name: string;
  readonly namespace: Namespace;
  readonly method: string;
  readonly args?: readonly unknown[];
  readonly channel: string;
  readonly schema: ZodType<unknown>;
  readonly payload?: unknown;
}> = [
  { name: "application getSnapshot", namespace: "application", method: "getSnapshot", channel: APPLICATION_IPC_CHANNELS.getSnapshot, schema: applicationSnapshotSchema },
  { name: "application retry", namespace: "application", method: "retry", channel: APPLICATION_IPC_CHANNELS.retry, schema: applicationSnapshotSchema },
  { name: "application quit", namespace: "application", method: "quit", channel: APPLICATION_IPC_CHANNELS.quit, schema: applicationVoidSchema },
  { name: "projects getSnapshot", namespace: "projects", method: "getSnapshot", channel: PROJECT_IPC_CHANNELS.getSnapshot, schema: projectLifecycleSnapshotSchema },
  { name: "projects pickAndOpen", namespace: "projects", method: "pickAndOpen", channel: PROJECT_IPC_CHANNELS.pickAndOpen, schema: projectOperationResultSchema },
  { name: "projects openRecent", namespace: "projects", method: "openRecent", args: ["instance"], channel: PROJECT_IPC_CHANNELS.openRecent, schema: projectOperationResultSchema, payload: { instanceKey: "instance" } },
  { name: "projects initialize", namespace: "projects", method: "initialize", args: [3, manifest], channel: PROJECT_IPC_CHANNELS.initialize, schema: projectOperationResultSchema, payload: { generation: 3, manifest } },
  { name: "projects updateManifest", namespace: "projects", method: "updateManifest", args: [3, manifest], channel: PROJECT_IPC_CHANNELS.updateManifest, schema: projectOperationResultSchema, payload: { generation: 3, manifest } },
  { name: "projects dismissPending", namespace: "projects", method: "dismissPending", args: [3], channel: PROJECT_IPC_CHANNELS.dismissPending, schema: projectOperationResultSchema, payload: { generation: 3 } },
  { name: "projects setTrust", namespace: "projects", method: "setTrust", args: [3, "trusted"], channel: PROJECT_IPC_CHANNELS.setTrust, schema: projectOperationResultSchema, payload: { generation: 3, decision: "trusted" } },
  { name: "projects refresh", namespace: "projects", method: "refresh", args: [3], channel: PROJECT_IPC_CHANNELS.refresh, schema: projectOperationResultSchema, payload: { generation: 3 } },
  { name: "projects close", namespace: "projects", method: "close", args: [3], channel: PROJECT_IPC_CHANNELS.close, schema: projectOperationResultSchema, payload: { generation: 3 } },
  { name: "projects removeRecent", namespace: "projects", method: "removeRecent", args: ["instance"], channel: PROJECT_IPC_CHANNELS.removeRecent, schema: projectOperationResultSchema, payload: { instanceKey: "instance" } },
  { name: "projects updatePersonalState", namespace: "projects", method: "updatePersonalState", args: [3, personalState], channel: PROJECT_IPC_CHANNELS.updatePersonalState, schema: projectOperationResultSchema, payload: { generation: 3, personalState } },
  { name: "projects prepareWorkspace", namespace: "projects", method: "prepareWorkspace", args: [3], channel: PROJECT_IPC_CHANNELS.prepareWorkspace, schema: projectOperationResultSchema, payload: { generation: 3 } },
  { name: "changes getSnapshot", namespace: "changes", method: "getSnapshot", args: [3], channel: CHANGE_IPC_CHANNELS.getSnapshot, schema: changeWorkspaceSnapshotSchema, payload: { generation: 3 } },
  { name: "changes scan", namespace: "changes", method: "scan", args: [3], channel: CHANGE_IPC_CHANNELS.scan, schema: changeOperationResultSchema, payload: { generation: 3 } },
  { name: "changes updateSelection", namespace: "changes", method: "updateSelection", args: [3, "changes", 7, selection], channel: CHANGE_IPC_CHANNELS.updateSelection, schema: changeOperationResultSchema, payload: { generation: 3, changeSetId: "changes", expectedRevision: 7, selection } },
  { name: "changes prepareApply", namespace: "changes", method: "prepareApply", args: [3, "changes", 7], channel: CHANGE_IPC_CHANNELS.prepareApply, schema: preparedApplyResultSchema, payload: { generation: 3, changeSetId: "changes", expectedRevision: 7 } },
  { name: "changes commitApply", namespace: "changes", method: "commitApply", args: [3, transactionId, planDigest], channel: CHANGE_IPC_CHANNELS.commitApply, schema: changeOperationResultSchema, payload: { generation: 3, transactionId, planDigest } },
  { name: "changes discard", namespace: "changes", method: "discard", args: [3, "changes", 7, true], channel: CHANGE_IPC_CHANNELS.discard, schema: changeOperationResultSchema, payload: { generation: 3, changeSetId: "changes", expectedRevision: 7, confirmUnappliedLoss: true } },
  { name: "changes recover", namespace: "changes", method: "recover", args: [3, transactionId, "roll-back"], channel: CHANGE_IPC_CHANNELS.recover, schema: changeOperationResultSchema, payload: { generation: 3, transactionId, action: "roll-back" } },
  { name: "runtime getSnapshot", namespace: "runtime", method: "getSnapshot", args: [3], channel: RUNTIME_IPC_CHANNELS.getSnapshot, schema: runtimeWorkspaceSnapshotSchema, payload: { generation: 3 } },
  { name: "runtime start", namespace: "runtime", method: "start", args: [3, "vite", 7], channel: RUNTIME_IPC_CHANNELS.start, schema: runtimeOperationResultSchema, payload: { generation: 3, profileName: "vite", expectedRevision: 7 } },
  { name: "runtime attach", namespace: "runtime", method: "attach", args: [3, "http://127.0.0.1:3000", 7], channel: RUNTIME_IPC_CHANNELS.attach, schema: runtimeOperationResultSchema, payload: { generation: 3, url: "http://127.0.0.1:3000", expectedRevision: 7 } },
  { name: "runtime discover", namespace: "runtime", method: "discover", args: [3, 7], channel: RUNTIME_IPC_CHANNELS.discover, schema: runtimeOperationResultSchema, payload: { generation: 3, expectedRevision: 7 } },
  { name: "runtime cancel", namespace: "runtime", method: "cancel", args: [3, operationId], channel: RUNTIME_IPC_CHANNELS.cancel, schema: runtimeOperationResultSchema, payload: { generation: 3, operationId } },
  { name: "runtime stop", namespace: "runtime", method: "stop", args: [3, sessionId, 7], channel: RUNTIME_IPC_CHANNELS.stop, schema: runtimeOperationResultSchema, payload: { generation: 3, sessionId, expectedRevision: 7 } },
  { name: "runtime detach", namespace: "runtime", method: "detach", args: [3, sessionId, 7], channel: RUNTIME_IPC_CHANNELS.detach, schema: runtimeOperationResultSchema, payload: { generation: 3, sessionId, expectedRevision: 7 } },
  { name: "runtime restart", namespace: "runtime", method: "restart", args: [3, sessionId, 7], channel: RUNTIME_IPC_CHANNELS.restart, schema: runtimeOperationResultSchema, payload: { generation: 3, sessionId, expectedRevision: 7 } },
  { name: "canvas load", namespace: "canvas", method: "load", args: [3, "surface"], channel: CANVAS_IPC_CHANNELS.load, schema: canvasAckSchema, payload: { generation: 3, surfaceId: "surface" } },
  { name: "canvas navigate", namespace: "canvas", method: "navigate", args: [3, "surface", "/work"], channel: CANVAS_IPC_CHANNELS.navigate, schema: canvasAckSchema, payload: { generation: 3, surfaceId: "surface", route: "/work" } },
];

test("every preload invoke maps to its exact channel, payload, and output schema", async () => {
  for (const testCase of invokeCases) {
    const transport = new RecordingTransport();
    const bridge = createPreloadBridge(transport);
    await call(bridge, testCase.namespace, testCase.method, testCase.args) as Promise<unknown>;
    assert.deepEqual(transport.invokes, [{
      channel: testCase.channel,
      schema: testCase.schema,
      payload: testCase.payload ?? {},
    }], testCase.name);
    inputSchemaByChannel[testCase.channel]!.parse(testCase.payload ?? {});
  }
});

test("the preload contract inventory cannot grow without an explicit mapping test", () => {
  const bridge = createPreloadBridge(new RecordingTransport());
  for (const namespace of Object.keys(expectedBridgeMethods) as Namespace[]) {
    assert.deepEqual(
      Object.keys(bridge[namespace]).sort(),
      [...expectedBridgeMethods[namespace]].sort(),
      namespace,
    );
  }

  const coveredChannels = new Set([
    ...invokeCases.map((testCase) => testCase.channel),
    CANVAS_IPC_CHANNELS.bounds,
    CANVAS_IPC_CHANNELS.show,
    CANVAS_IPC_CHANNELS.focus,
    CANVAS_IPC_CHANNELS.hide,
    APPLICATION_IPC_CHANNELS.snapshot,
    PROJECT_IPC_CHANNELS.snapshot,
    CHANGE_IPC_CHANNELS.snapshot,
    RUNTIME_IPC_CHANNELS.snapshot,
    CANVAS_IPC_CHANNELS.navigated,
    CANVAS_IPC_CHANNELS.focusReturn,
  ]);
  const declaredChannels = new Set([
    ...Object.values(APPLICATION_IPC_CHANNELS),
    ...Object.values(PROJECT_IPC_CHANNELS),
    ...Object.values(CHANGE_IPC_CHANNELS),
    ...Object.values(RUNTIME_IPC_CHANNELS),
    ...Object.values(CANVAS_IPC_CHANNELS),
  ]);
  assert.deepEqual([...coveredChannels].sort(), [...declaredChannels].sort());
});

test("every preload invoke rejects a value outside its declared output schema", async () => {
  for (const testCase of invokeCases) {
    const bridge = createPreloadBridge(new RecordingTransport(true));
    await assert.rejects(
      Promise.resolve(call(bridge, testCase.namespace, testCase.method, testCase.args)),
      testCase.name,
    );
  }
});

test("every fire-and-forget canvas command maps to its exact channel and payload", () => {
  const cases = [
    { method: "setBounds", args: [3, "surface", bounds], channel: CANVAS_IPC_CHANNELS.bounds, payload: { generation: 3, surfaceId: "surface", bounds } },
    { method: "show", args: [3, "surface"], channel: CANVAS_IPC_CHANNELS.show, payload: { generation: 3, surfaceId: "surface" } },
    { method: "focus", args: [3, "surface"], channel: CANVAS_IPC_CHANNELS.focus, payload: { generation: 3, surfaceId: "surface" } },
    { method: "hide", args: [3, "surface"], channel: CANVAS_IPC_CHANNELS.hide, payload: { generation: 3, surfaceId: "surface" } },
  ] as const;
  for (const testCase of cases) {
    const transport = new RecordingTransport();
    call(createPreloadBridge(transport), "canvas", testCase.method, testCase.args);
    assert.deepEqual(transport.sends, [{ channel: testCase.channel, payload: testCase.payload }], testCase.method);
    inputSchemaByChannel[testCase.channel]!.parse(testCase.payload);
  }
});

test("every preload event maps to its exact channel, stream, and payload schema", () => {
  const cases = [
    { namespace: "application", method: "onSnapshot", channel: APPLICATION_IPC_CHANNELS.snapshot, stream: "application.snapshot", schema: applicationSnapshotSchema },
    { namespace: "projects", method: "onSnapshot", channel: PROJECT_IPC_CHANNELS.snapshot, stream: "projects.snapshot", schema: projectLifecycleSnapshotSchema },
    { namespace: "changes", method: "onSnapshot", channel: CHANGE_IPC_CHANNELS.snapshot, stream: "changes.snapshot", schema: changeWorkspaceSnapshotSchema },
    { namespace: "runtime", method: "onSnapshot", channel: RUNTIME_IPC_CHANNELS.snapshot, stream: "runtime.snapshot", schema: runtimeWorkspaceSnapshotSchema },
    { namespace: "canvas", method: "onNavigation", channel: CANVAS_IPC_CHANNELS.navigated, stream: "canvas.navigated", schema: canvasNavigationSchema },
    { namespace: "canvas", method: "onFocusReturn", channel: CANVAS_IPC_CHANNELS.focusReturn, stream: "canvas.focus-return", schema: canvasFocusReturnSchema },
  ] as const;

  for (const testCase of cases) {
    const transport = new RecordingTransport();
    const unsubscribe = call(
      createPreloadBridge(transport),
      testCase.namespace,
      testCase.method,
      [() => undefined],
    );
    assert.equal(typeof unsubscribe, "function", testCase.method);
    assert.deepEqual(transport.subscriptions, [{
      channel: testCase.channel,
      stream: testCase.stream,
      schema: testCase.schema,
    }], testCase.method);
    assert.throws(() => testCase.schema.parse(Symbol("invalid-event")), testCase.method);
  }
});
