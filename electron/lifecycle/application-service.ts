import { randomUUID } from "node:crypto";

import {
  APPLICATION_SNAPSHOT_FORMAT_VERSION,
  type ApplicationServiceName,
  type ApplicationServiceStatus,
  type ApplicationSnapshot,
} from "../../src/desktop/application-contract.js";
import { DESKTOP_PROTOCOL_VERSION, DesktopBridgeError, type DesktopError } from "../../src/desktop/protocol.js";

type ApplicationSnapshotListener = (snapshot: ApplicationSnapshot) => void;

const SERVICE_NAMES: readonly ApplicationServiceName[] = [
  "projects",
  "workspaces",
  "changes",
  "runtime",
  "editor",
];

function pendingServices(): ApplicationSnapshot["services"] {
  return Object.fromEntries(SERVICE_NAMES.map((name) => [name, {
    status: "pending",
    problem: null,
  }])) as ApplicationSnapshot["services"];
}

function applicationError(cause: unknown): DesktopError {
  if (cause instanceof DesktopBridgeError) {
    return {
      code: cause.code,
      message: cause.message,
      retryable: cause.retryable,
    };
  }
  return {
    code: "application-operation-failed",
    message: "The desktop services could not be started.",
    retryable: true,
  };
}

export class ApplicationService {
  private readonly listeners = new Set<ApplicationSnapshotListener>();
  private readonly retryOperation: () => Promise<void>;
  private readonly quitOperation: () => Promise<void> | void;
  private retryPromise: Promise<ApplicationSnapshot> | null = null;
  private snapshotValue: ApplicationSnapshot;

  constructor(options: {
    readonly bootId?: string;
    readonly retry: () => Promise<void>;
    readonly quit: () => Promise<void> | void;
  }) {
    this.retryOperation = options.retry;
    this.quitOperation = options.quit;
    this.snapshotValue = {
      formatVersion: APPLICATION_SNAPSHOT_FORMAT_VERSION,
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      bootId: options.bootId ?? randomUUID(),
      revision: 0,
      phase: "starting",
      services: pendingServices(),
      problem: null,
    };
  }

  snapshot(): ApplicationSnapshot {
    return structuredClone(this.snapshotValue);
  }

  subscribe(listener: ApplicationSnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  startRecovery(): void {
    this.update({ phase: "recovering", problem: null });
  }

  setService(
    name: ApplicationServiceName,
    status: ApplicationServiceStatus["status"],
    problem: DesktopError | null = null,
  ): void {
    const services = {
      ...this.snapshotValue.services,
      [name]: { status, problem },
    };
    this.update({ services });
  }

  markReady(): void {
    const services = Object.fromEntries(SERVICE_NAMES.map((name) => {
      const current = this.snapshotValue.services[name];
      return [name, current.status === "pending" ? { status: "ready", problem: null } : current];
    })) as ApplicationSnapshot["services"];
    const degraded = Object.values(services).some((service) => service.status === "degraded");
    const unavailable = Object.values(services).some((service) => service.status === "unavailable");
    this.update({
      services,
      phase: unavailable ? "unavailable" : degraded ? "degraded" : "ready",
      problem: unavailable ? this.snapshotValue.problem : null,
    });
  }

  markUnavailable(cause: unknown): void {
    this.update({ phase: "unavailable", problem: applicationError(cause) });
  }

  beginShutdown(): void {
    if (this.snapshotValue.phase !== "shutting-down") {
      this.update({ phase: "shutting-down" });
    }
  }

  retry(): Promise<ApplicationSnapshot> {
    if (this.retryPromise) return this.retryPromise;
    if (this.snapshotValue.phase !== "unavailable" && this.snapshotValue.phase !== "degraded") {
      return Promise.resolve(this.snapshot());
    }
    this.startRecovery();
    this.retryPromise = this.retryOperation().then(() => {
      if (this.snapshotValue.phase === "recovering") this.markReady();
      return this.snapshot();
    }).catch((cause: unknown) => {
      this.markUnavailable(cause);
      return this.snapshot();
    }).finally(() => {
      this.retryPromise = null;
    });
    return this.retryPromise;
  }

  async quit(): Promise<void> {
    this.beginShutdown();
    await this.quitOperation();
  }

  private update(patch: Partial<Omit<ApplicationSnapshot, "formatVersion" | "protocolVersion" | "bootId" | "revision">>): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      ...patch,
      revision: this.snapshotValue.revision + 1,
    };
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
