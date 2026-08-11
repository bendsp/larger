import type { BrowserWindow, Dialog } from "electron";
import { z } from "zod";
import {
  generationInputSchema,
  initializeInputSchema,
  personalStateInputSchema,
  PROJECT_IPC_CHANNELS,
  projectLifecycleSnapshotSchema,
  projectOperationResultSchema,
  recentInputSchema,
  trustInputSchema,
} from "../../src/project-ipc.js";
import type { ProjectManager } from "../projects/project-manager.js";
import type {
  DesktopIpcOperationContext,
  DesktopIpcRouter,
} from "./desktop-ipc-router.js";
import type { ProjectOperationResult } from "../../src/project-ipc.js";

const emptyInputSchema = z.object({}).strict();

export interface ProjectIpcDependencies {
  readonly router: DesktopIpcRouter;
  readonly dialog: Pick<Dialog, "showOpenDialog">;
  readonly manager: ProjectManager;
  readonly getWindow: () => BrowserWindow | null;
  readonly pickAndOpen?: (context: DesktopIpcOperationContext) => Promise<ProjectOperationResult>;
  readonly openRecent?: (
    instanceKey: string,
    context: DesktopIpcOperationContext,
  ) => Promise<ProjectOperationResult>;
  readonly removeRecent?: (
    instanceKey: string,
    context: DesktopIpcOperationContext,
  ) => Promise<ProjectOperationResult>;
}

export function registerProjectIpc(dependencies: ProjectIpcDependencies): () => void {
  const { router, dialog, manager, getWindow } = dependencies;
  let picker: Promise<unknown> | null = null;
  const disposeHandlers = [
    router.register({
      channel: PROJECT_IPC_CHANNELS.getSnapshot,
      input: emptyInputSchema,
      output: projectLifecycleSnapshotSchema,
      failureCode: "project-operation-failed",
      run: () => manager.snapshot(),
    }),
    router.register({
      channel: PROJECT_IPC_CHANNELS.pickAndOpen,
      input: emptyInputSchema,
      output: projectOperationResultSchema,
      failureCode: "project-operation-failed",
      run: async (_input, context) => {
        if (dependencies.pickAndOpen) return dependencies.pickAndOpen(context);
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
          context.assertCurrent();
          if (result.canceled || result.filePaths.length === 0) {
            return { status: "cancelled" as const, snapshot: manager.snapshot() };
          }
          return manager.openPath(result.filePaths[0]!, undefined, { signal: context.signal });
        } finally {
          picker = null;
        }
      },
    }),
    router.register({
      channel: PROJECT_IPC_CHANNELS.openRecent,
      input: recentInputSchema,
      output: projectOperationResultSchema,
      failureCode: "project-operation-failed",
      run: ({ instanceKey }, context) => dependencies.openRecent
        ? dependencies.openRecent(instanceKey, context)
        : manager.openRecent(instanceKey, { signal: context.signal }),
    }),
    router.register({
      channel: PROJECT_IPC_CHANNELS.initialize,
      input: initializeInputSchema,
      output: projectOperationResultSchema,
      failureCode: "project-operation-failed",
      run: ({ generation, manifest }, context) => manager.initialize(generation, manifest, { signal: context.signal }),
    }),
    router.register({
      channel: PROJECT_IPC_CHANNELS.updateManifest,
      input: initializeInputSchema,
      output: projectOperationResultSchema,
      failureCode: "project-operation-failed",
      run: ({ generation, manifest }, context) => manager.updateManifest(generation, manifest, { signal: context.signal }),
    }),
    router.register({
      channel: PROJECT_IPC_CHANNELS.dismissPending,
      input: generationInputSchema,
      output: projectOperationResultSchema,
      failureCode: "project-operation-failed",
      run: ({ generation }, context) => manager.dismissPending(generation, { signal: context.signal }),
    }),
    router.register({
      channel: PROJECT_IPC_CHANNELS.setTrust,
      input: trustInputSchema,
      output: projectOperationResultSchema,
      failureCode: "project-operation-failed",
      run: ({ generation, decision }, context) => manager.setTrust(generation, decision, { signal: context.signal }),
    }),
    router.register({
      channel: PROJECT_IPC_CHANNELS.refresh,
      input: generationInputSchema,
      output: projectOperationResultSchema,
      failureCode: "project-operation-failed",
      run: ({ generation }, context) => manager.refresh(generation, { signal: context.signal }),
    }),
    router.register({
      channel: PROJECT_IPC_CHANNELS.close,
      input: generationInputSchema,
      output: projectOperationResultSchema,
      failureCode: "project-operation-failed",
      run: ({ generation }, context) => manager.close(generation, { signal: context.signal }),
    }),
    router.register({
      channel: PROJECT_IPC_CHANNELS.removeRecent,
      input: recentInputSchema,
      output: projectOperationResultSchema,
      failureCode: "project-operation-failed",
      run: ({ instanceKey }, context) => dependencies.removeRecent
        ? dependencies.removeRecent(instanceKey, context)
        : manager.removeRecent(instanceKey, { signal: context.signal }),
    }),
    router.register({
      channel: PROJECT_IPC_CHANNELS.updatePersonalState,
      input: personalStateInputSchema,
      output: projectOperationResultSchema,
      failureCode: "project-operation-failed",
      run: ({ generation, personalState }, context) => manager.updatePersonalState(generation, personalState, { signal: context.signal }),
    }),
    router.register({
      channel: PROJECT_IPC_CHANNELS.prepareWorkspace,
      input: generationInputSchema,
      output: projectOperationResultSchema,
      failureCode: "project-operation-failed",
      run: ({ generation }, context) => manager.prepareWorkspace(generation, { signal: context.signal }),
    }),
  ];

  const unsubscribe = manager.subscribe((snapshot) => {
    router.publish(
      getWindow(),
      PROJECT_IPC_CHANNELS.snapshot,
      "projects.snapshot",
      projectLifecycleSnapshotSchema,
      snapshot,
    );
  });

  return () => {
    unsubscribe();
    for (const dispose of disposeHandlers) dispose();
  };
}
