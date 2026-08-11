import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import type { ChangeSelection, TextFileChange } from "../../src/change-contracts.js";
import type { ActiveProject } from "../../src/project-ipc.js";
import { ProjectActivityCoordinator } from "../projects/project-activity.js";
import { RuntimeWorkspaceProvider } from "../runtime-workspaces/provider.js";
import { ChangeService, type ChangeTransactionPhase } from "./change-service.js";

interface CrashChildConfig {
  readonly userDataPath: string;
  readonly sourceRoot: string;
  readonly instanceKey: string;
  readonly active: ActiveProject;
  readonly markerPath: string;
  readonly transactionId?: string;
  readonly planDigest?: string;
}

function selectionFor(files: readonly TextFileChange[]): ChangeSelection {
  return {
    files: files.map((file) => ({
      fileId: file.id,
      includeFile: true,
      hunkIds: file.hunks.map((hunk) => hunk.id),
    })),
  };
}

async function main(): Promise<void> {
  const [configPath, operation, crashPhase] = process.argv.slice(2);
  if (!configPath || !operation || !crashPhase) throw new Error("Crash child arguments are incomplete.");
  const config = JSON.parse(await readFile(configPath, "utf8")) as CrashChildConfig;
  const provider = new RuntimeWorkspaceProvider({
    userDataPath: config.userDataPath,
    localInstanceKey: config.instanceKey,
  });
  const service = new ChangeService({
    userDataPath: config.userDataPath,
    projects: {
      activeForChanges: (generation) => {
        if (generation !== config.active.generation) throw new Error("stale crash-child generation");
        return structuredClone(config.active);
      },
      authorizeSourceOperation: async (generation, instanceKey) => {
        if (generation !== config.active.generation || instanceKey !== config.instanceKey) {
          throw new Error("stale crash-child source authorization");
        }
        return structuredClone(config.active);
      },
    },
    workspaces: {
      current: async () => provider.current(),
      for: () => ({
        current: async () => provider.current(),
        resetCurrent: async () => provider.resetCurrent(),
      }),
    },
    activity: new ProjectActivityCoordinator(),
    onTransactionPhase: (phase: ChangeTransactionPhase) => {
      if (phase !== crashPhase) return;
      writeFileSync(config.markerPath, `${phase}\n`, { mode: 0o600 });
      process.kill(process.pid, "SIGKILL");
    },
  });

  if (operation === "prepare") {
    const scanned = await service.scan(config.active.generation);
    const changeSet = scanned.snapshot.changeSet;
    if (!changeSet) throw new Error("Crash child scan produced no ChangeSet.");
    const files = changeSet.files.filter((file): file is TextFileChange => file.kind === "text");
    const selected = await service.updateSelection(
      config.active.generation,
      changeSet.id,
      changeSet.revision,
      selectionFor(files),
    );
    const selectedChangeSet = selected.snapshot.changeSet;
    if (!selectedChangeSet) throw new Error("Crash child selection disappeared.");
    await service.prepareApply(config.active.generation, selectedChangeSet.id, selectedChangeSet.revision);
  } else if (operation === "commit") {
    if (!config.transactionId || !config.planDigest) throw new Error("Commit crash config is incomplete.");
    await service.commitApply(config.active.generation, config.transactionId, config.planDigest);
  } else if (operation === "recover") {
    if (!config.transactionId) throw new Error("Recovery crash config is incomplete.");
    await service.recover(config.active.generation, config.transactionId, "roll-forward");
  } else {
    throw new Error(`Unknown crash child operation: ${operation}`);
  }
  throw new Error(`Operation completed without reaching crash phase ${crashPhase}.`);
}

void main().catch((cause) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
