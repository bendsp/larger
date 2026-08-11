import type { RuntimeEndpoint, RuntimeSurface } from "../../src/runtime-contracts.js";
import type { RedactingLogBuffer } from "./redacting-log-buffer.js";
import type { ProcessSupervisor, SupervisedProcess } from "./process-supervisor.js";

export class EditorSecurityError extends Error {
  override readonly name = "EditorSecurityError";
}

export interface EditorStartInput {
  readonly sessionId: string;
  readonly projectInstanceKey: string;
  readonly projectGeneration: number;
  readonly runtimeId: string;
  readonly runtimePath: string;
  readonly target: RuntimeEndpoint;
  readonly capability: string;
  readonly signal: AbortSignal;
  readonly supervisor: ProcessSupervisor;
  readonly logs: RedactingLogBuffer;
}

export interface StartedEditor {
  readonly process: SupervisedProcess | null;
  readonly surface: RuntimeSurface;
  readonly privateState?: unknown;
}

export interface EditorAdapter {
  readonly id: string;
  start(input: EditorStartInput): Promise<StartedEditor>;
  verify(started: StartedEditor, signal: AbortSignal): Promise<void>;
  surfaceUrl(started: StartedEditor): string;
  stop?(started: StartedEditor, signal: AbortSignal): Promise<void>;
}

export interface EditorAdapterRegistry {
  get(id: string): EditorAdapter | undefined;
}

export class StaticEditorAdapterRegistry implements EditorAdapterRegistry {
  private readonly adapters: Map<string, EditorAdapter>;

  constructor(adapters: readonly EditorAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  get(id: string): EditorAdapter | undefined {
    return this.adapters.get(id);
  }
}
