import type { ProjectIdentity } from "../../src/project-contracts.js";
import { RuntimeWorkspaceProvider } from "./provider.js";
import type { RuntimeWorkspace } from "./types.js";

export interface RuntimeWorkspaceAccess {
  stage(sourceRoot: string, options?: { signal?: AbortSignal }): Promise<RuntimeWorkspace>;
  current(): Promise<RuntimeWorkspace | undefined>;
  resetCurrent(signal?: AbortSignal): Promise<RuntimeWorkspace>;
}

export interface RuntimeWorkspaceRegistryOptions {
  readonly userDataPath: string;
  readonly createProvider?: (identity: ProjectIdentity) => RuntimeWorkspaceAccess;
}

export class RuntimeWorkspaceRegistry {
  private readonly providers = new Map<string, RuntimeWorkspaceAccess>();
  private readonly createProvider: (identity: ProjectIdentity) => RuntimeWorkspaceAccess;

  constructor(options: RuntimeWorkspaceRegistryOptions) {
    this.createProvider = options.createProvider ?? ((identity) => new RuntimeWorkspaceProvider({
      userDataPath: options.userDataPath,
      localInstanceKey: identity.instanceKey,
    }));
  }

  for(identity: ProjectIdentity): RuntimeWorkspaceAccess {
    let provider = this.providers.get(identity.instanceKey);
    if (!provider) {
      provider = this.createProvider(identity);
      this.providers.set(identity.instanceKey, provider);
    }
    return provider;
  }

  current(identity: ProjectIdentity): Promise<RuntimeWorkspace | undefined> {
    return this.for(identity).current();
  }

  clear(instanceKey?: string): void {
    if (instanceKey) this.providers.delete(instanceKey);
    else this.providers.clear();
  }
}
