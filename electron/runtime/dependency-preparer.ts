import type { RuntimeProfile } from "../../src/project-contracts.js";
import type { DependencyService } from "../runtime-workspaces/dependencies/service.js";
import type { RuntimeWorkspace, UnpublishedRuntimeWorkspace } from "../runtime-workspaces/types.js";
import type {
  AuthorizedRuntimeProject,
  DependencyPreparationResult,
  RuntimeDependencyPreparer,
} from "./runtime-service.js";

export interface DependencyServiceResolver {
  for(project: AuthorizedRuntimeProject): Promise<DependencyService>;
}

export class DependencyServiceRuntimePreparer implements RuntimeDependencyPreparer {
  constructor(private readonly services: DependencyServiceResolver) {}

  async createPreparation(input: {
    readonly project: AuthorizedRuntimeProject;
    readonly profile: RuntimeProfile;
    readonly signal: AbortSignal;
  }): Promise<{
    prepareRuntime(candidate: UnpublishedRuntimeWorkspace): Promise<DependencyPreparationResult>;
  }> {
    input.signal.throwIfAborted();
    const service = await this.services.for(input.project);
    input.signal.throwIfAborted();
    return {
      prepareRuntime: async (candidate) => {
        const installation = await service.prepareRuntime(candidate, {
          workingDirectory: input.profile.dependencyRoot,
          signal: input.signal,
        });
        return { identity: installation.snapshotIdentity };
      },
    };
  }

  async restoreCurrent(input: {
    readonly project: AuthorizedRuntimeProject;
    readonly profile: RuntimeProfile;
    readonly workspace: RuntimeWorkspace;
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly status: "restored"; readonly result: DependencyPreparationResult }
    | { readonly status: "missing" }
  > {
    input.signal.throwIfAborted();
    const service = await this.services.for(input.project);
    input.signal.throwIfAborted();
    const installation = await service.restoreCurrent(input.workspace, {
      workingDirectory: input.profile.dependencyRoot,
      signal: input.signal,
    });
    if (!installation) return { status: "missing" };
    return {
      status: "restored",
      result: { identity: installation.snapshotIdentity },
    };
  }
}
