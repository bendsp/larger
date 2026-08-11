import type { RuntimeEndpoint } from "../../src/runtime-contracts.js";
import type { RuntimeProfile } from "../../src/project-contracts.js";

export interface RuntimeSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface RuntimeReadinessPolicy {
  readonly url: string;
  readonly timeoutMs: number;
}

export interface RuntimeLaunchPlan {
  readonly spawn: RuntimeSpawnSpec;
  readonly endpoint: RuntimeEndpoint;
  readonly readiness: RuntimeReadinessPolicy;
}

export interface RuntimeAdapterInput {
  readonly profile: RuntimeProfile;
  readonly runtimePath: string;
  readonly workingDirectory: string;
  readonly port: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface RuntimeAdapter {
  readonly id: string;
  plan(input: RuntimeAdapterInput): Promise<RuntimeLaunchPlan>;
}

export interface RuntimeAdapterRegistry {
  get(id: string): RuntimeAdapter | undefined;
}

function replacePlaceholder(value: string, host: string, port: number): string {
  return value.replaceAll("{host}", host).replaceAll("{port}", String(port));
}

export class CommandRuntimeAdapter implements RuntimeAdapter {
  constructor(readonly id = "command") {}

  async plan(input: RuntimeAdapterInput): Promise<RuntimeLaunchPlan> {
    input.signal.throwIfAborted();
    const [rawCommand, ...rawArgs] = input.profile.command;
    if (!rawCommand) throw new Error("The runtime command is empty");
    const host = input.profile.host;
    const origin = `http://${host}:${input.port}`;
    const route = input.profile.entryRoute;
    return {
      spawn: {
        command: replacePlaceholder(rawCommand, host, input.port),
        args: rawArgs.map((argument) => replacePlaceholder(argument, host, input.port)),
        cwd: input.workingDirectory,
        environment: input.environment,
      },
      endpoint: {
        origin,
        route,
        displayUrl: new URL(route, `${origin}/`).toString(),
        portAllocation: { preferred: input.profile.preferredPort, actual: input.port },
      },
      readiness: {
        url: new URL(input.profile.readiness.path, `${origin}/`).toString(),
        timeoutMs: input.profile.readiness.timeoutMs,
      },
    };
  }
}

export const DEFAULT_COMMAND_RUNTIME_ADAPTER_IDS = ["command", "auto", "vite", "next", "react-scripts"] as const;

export function createDefaultRuntimeAdapterRegistry(): StaticRuntimeAdapterRegistry {
  return new StaticRuntimeAdapterRegistry(
    DEFAULT_COMMAND_RUNTIME_ADAPTER_IDS.map((id) => new CommandRuntimeAdapter(id)),
  );
}

export class StaticRuntimeAdapterRegistry implements RuntimeAdapterRegistry {
  private readonly adapters: Map<string, RuntimeAdapter>;

  constructor(adapters: readonly RuntimeAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  get(id: string): RuntimeAdapter | undefined {
    return this.adapters.get(id);
  }
}
