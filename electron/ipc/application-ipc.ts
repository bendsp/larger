import type { BrowserWindow } from "electron";
import { z } from "zod";
import {
  APPLICATION_IPC_CHANNELS,
  applicationSnapshotSchema,
  type ApplicationSnapshot,
} from "../../src/desktop/application-contract.js";
import type { DesktopIpcRouter } from "./desktop-ipc-router.js";

const emptyInputSchema = z.object({}).strict();
const emptyOutputSchema = z.object({}).strict();

export interface ApplicationServicePort {
  snapshot(): ApplicationSnapshot;
  retry(): Promise<ApplicationSnapshot> | ApplicationSnapshot;
  quit(): Promise<void> | void;
  subscribe(listener: (snapshot: ApplicationSnapshot) => void): () => void;
}

export interface ApplicationIpcDependencies {
  readonly router: DesktopIpcRouter;
  readonly service: ApplicationServicePort;
  readonly getWindow: () => BrowserWindow | null;
}

export function registerApplicationIpc(dependencies: ApplicationIpcDependencies): () => void {
  const { router, service, getWindow } = dependencies;
  const disposeHandlers = [
    router.register({
      channel: APPLICATION_IPC_CHANNELS.getSnapshot,
      input: emptyInputSchema,
      output: applicationSnapshotSchema,
      failureCode: "application-operation-failed",
      run: () => service.snapshot(),
    }),
    router.register({
      channel: APPLICATION_IPC_CHANNELS.retry,
      input: emptyInputSchema,
      output: applicationSnapshotSchema,
      failureCode: "application-operation-failed",
      run: () => service.retry(),
    }),
    router.register({
      channel: APPLICATION_IPC_CHANNELS.quit,
      input: emptyInputSchema,
      output: emptyOutputSchema,
      failureCode: "application-operation-failed",
      run: async () => {
        await service.quit();
        return {};
      },
    }),
  ];
  const unsubscribe = service.subscribe((snapshot) => {
    router.publish(
      getWindow(),
      APPLICATION_IPC_CHANNELS.snapshot,
      "application.snapshot",
      applicationSnapshotSchema,
      snapshot,
    );
  });
  return () => {
    unsubscribe();
    for (const dispose of disposeHandlers) dispose();
  };
}
