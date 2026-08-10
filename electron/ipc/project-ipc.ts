import type {
  BrowserWindow,
  Dialog,
  IpcMain,
  IpcMainInvokeEvent,
} from "electron";
import { ZodError, type ZodType } from "zod";
import {
  generationInputSchema,
  initializeInputSchema,
  personalStateInputSchema,
  PROJECT_IPC_CHANNELS,
  recentInputSchema,
  trustInputSchema,
  type IpcDomainError,
  type IpcEnvelope,
} from "../../src/project-ipc.js";
import type { ProjectManager } from "../projects/project-manager.js";

export interface ProjectIpcDependencies {
  ipcMain: IpcMain;
  dialog: Pick<Dialog, "showOpenDialog">;
  manager: ProjectManager;
  getWindow(): BrowserWindow | null;
  assertTrustedSender(event: IpcMainInvokeEvent): void;
}

function domainError(cause: unknown): IpcDomainError {
  if (cause instanceof ZodError) {
    return {
      code: "invalid-ipc-payload",
      message: "The renderer sent an invalid project operation.",
      details: cause.issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message })),
    };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    code: /stale/i.test(message) ? "stale-generation" : "project-operation-failed",
    message,
  };
}

function success<T>(value: T): IpcEnvelope<T> {
  return { ok: true, value };
}

function failure<T>(cause: unknown): IpcEnvelope<T> {
  return { ok: false, error: domainError(cause) };
}

export function registerProjectIpc(dependencies: ProjectIpcDependencies): () => void {
  const { ipcMain, dialog, manager, getWindow, assertTrustedSender } = dependencies;
  let picker: Promise<unknown> | null = null;
  const channels: string[] = [];

  function handle<TInput, TResult>(
    channel: string,
    schema: ZodType<TInput> | null,
    operation: (input: TInput) => Promise<TResult> | TResult,
  ): void {
    channels.push(channel);
    ipcMain.handle(channel, async (event, raw: unknown): Promise<IpcEnvelope<TResult>> => {
      try {
        assertTrustedSender(event);
        const input = schema ? schema.parse(raw) : undefined as TInput;
        return success(await operation(input));
      } catch (cause) {
        return failure(cause);
      }
    });
  }

  handle(PROJECT_IPC_CHANNELS.getSnapshot, null, () => manager.snapshot());
  handle(PROJECT_IPC_CHANNELS.pickAndOpen, null, async () => {
    if (picker) throw new Error("A project folder picker is already open");
    const owner = getWindow();
    if (!owner) throw new Error("The Larger window is not available");
    picker = dialog.showOpenDialog(owner, {
      title: "Open project",
      buttonLabel: "Open project",
      properties: ["openDirectory", "createDirectory"],
    });
    try {
      const result = await picker as Awaited<ReturnType<Dialog["showOpenDialog"]>>;
      if (result.canceled || result.filePaths.length === 0) {
        return { status: "cancelled" as const, snapshot: manager.snapshot() };
      }
      return manager.openPath(result.filePaths[0]!);
    } finally {
      picker = null;
    }
  });
  handle(PROJECT_IPC_CHANNELS.openRecent, recentInputSchema, ({ instanceKey }) => manager.openRecent(instanceKey));
  handle(PROJECT_IPC_CHANNELS.initialize, initializeInputSchema, ({ generation, manifest }) => manager.initialize(generation, manifest));
  handle(PROJECT_IPC_CHANNELS.updateManifest, initializeInputSchema, ({ generation, manifest }) => manager.updateManifest(generation, manifest));
  handle(PROJECT_IPC_CHANNELS.dismissPending, generationInputSchema, ({ generation }) => manager.dismissPending(generation));
  handle(PROJECT_IPC_CHANNELS.setTrust, trustInputSchema, ({ generation, decision }) => manager.setTrust(generation, decision));
  handle(PROJECT_IPC_CHANNELS.refresh, generationInputSchema, ({ generation }) => manager.refresh(generation));
  handle(PROJECT_IPC_CHANNELS.close, generationInputSchema, ({ generation }) => manager.close(generation));
  handle(PROJECT_IPC_CHANNELS.removeRecent, recentInputSchema, ({ instanceKey }) => manager.removeRecent(instanceKey));
  handle(PROJECT_IPC_CHANNELS.updatePersonalState, personalStateInputSchema, ({ generation, personalState }) => (
    manager.updatePersonalState(generation, personalState)
  ));
  handle(PROJECT_IPC_CHANNELS.prepareWorkspace, generationInputSchema, ({ generation }) => manager.prepareWorkspace(generation));

  const unsubscribe = manager.subscribe((snapshot) => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(PROJECT_IPC_CHANNELS.snapshot, snapshot);
  });

  return () => {
    unsubscribe();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
