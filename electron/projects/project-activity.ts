import type { SessionSwitchGuard } from "./project-manager.js";

export class ProjectActivityConflictError extends Error {
  override readonly name = "ProjectActivityConflictError";
}

export interface ProjectActivityLease {
  readonly kind: "source-write";
  release(): void;
}

export interface ProjectRuntimeActivityParticipant {
  hasActiveRuntime(): boolean;
  stopForProjectSwitch(): Promise<void>;
}

export class ProjectActivityCoordinator implements SessionSwitchGuard {
  private sourceWriteOwner: string | null = null;
  private readonly runtimeParticipants = new Set<ProjectRuntimeActivityParticipant>();

  hasActiveSession(): boolean {
    return this.sourceWriteOwner !== null
      || [...this.runtimeParticipants].some((participant) => participant.hasActiveRuntime());
  }

  async stopForProjectSwitch(): Promise<void> {
    if (this.sourceWriteOwner) {
      throw new ProjectActivityConflictError("Finish or recover the active source transaction before switching projects.");
    }
    for (const participant of this.runtimeParticipants) {
      if (participant.hasActiveRuntime()) await participant.stopForProjectSwitch();
    }
  }

  registerRuntimeParticipant(participant: ProjectRuntimeActivityParticipant): () => void {
    this.runtimeParticipants.add(participant);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      this.runtimeParticipants.delete(participant);
    };
  }

  acquireSourceWrite(transactionId: string): ProjectActivityLease {
    if (this.sourceWriteOwner) {
      if (this.sourceWriteOwner === transactionId) {
        throw new ProjectActivityConflictError("This source transaction is already running.");
      }
      throw new ProjectActivityConflictError("Another source transaction is already running.");
    }
    this.sourceWriteOwner = transactionId;
    let released = false;
    return {
      kind: "source-write",
      release: () => {
        if (released) return;
        released = true;
        if (this.sourceWriteOwner === transactionId) this.sourceWriteOwner = null;
      },
    };
  }
}
