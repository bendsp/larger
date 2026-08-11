import { randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeProcessIdentity } from "../../src/runtime-contracts.js";
import type { RedactingLogBuffer } from "./redacting-log-buffer.js";
import type { RuntimeSpawnSpec } from "./runtime-adapter.js";
import type { OwnershipStore, RuntimeOwnershipRecord } from "./ownership-store.js";
import { POSIX_SUPERVISOR_SIDECAR_SOURCE } from "./supervisor-sidecar.js";

const execFileAsync = promisify(execFile);

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SupervisedProcess {
  readonly identity: RuntimeProcessIdentity;
  readonly role: "runtime" | "editor";
  readonly exit: Promise<ProcessExit>;
}

export interface SpawnSupervisedProcessInput {
  readonly sessionId: string;
  readonly role: "runtime" | "editor";
  readonly projectInstanceKey: string;
  readonly projectGeneration: number;
  readonly runtimeId: string;
  readonly runtimePath: string;
  readonly spec: RuntimeSpawnSpec;
  readonly logs: RedactingLogBuffer;
  readonly signal: AbortSignal;
  readonly onOutput?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
}

export interface RecoveryOutcome {
  readonly recordId: string;
  readonly status: "cleaned" | "already-exited" | "ownership-mismatch";
}

export interface ProcessSupervisor {
  readonly managedLaunchSupported: boolean;
  spawn(input: SpawnSupervisedProcessInput): Promise<SupervisedProcess>;
  stop(process: SupervisedProcess, signal?: AbortSignal): Promise<void>;
  recover(signal?: AbortSignal): Promise<readonly RecoveryOutcome[]>;
}

export interface ProcessInspector {
  inspect(pid: number): Promise<RuntimeProcessIdentity | undefined>;
}

export class DarwinProcessInspector implements ProcessInspector {
  async inspect(pid: number): Promise<RuntimeProcessIdentity | undefined> {
    try {
      const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "pgid=", "-o", "comm="]);
      const line = stdout.trim();
      const match = /^(.{24})\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) return undefined;
      const [, startedAt, group, executable] = match;
      const parsed = new Date(startedAt);
      if (Number.isNaN(parsed.valueOf())) return undefined;
      return {
        pid,
        executable,
        startedAt: parsed.toISOString(),
        processGroupId: Number(group),
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ESRCH" || (cause as { code?: number }).code === 1) return undefined;
      throw cause;
    }
  }
}

interface SidecarMessage {
  readonly type: "ready" | "started" | "log" | "cleaned" | "error" | "diagnostic";
  readonly pid?: number;
  readonly stream?: "stdout" | "stderr";
  readonly data?: string;
  readonly code?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly message?: string;
}

interface LiveProcess extends SupervisedProcess {
  readonly recordId: string;
  readonly nonce: string;
  readonly sidecar: ChildProcessWithoutNullStreams;
  readonly exited: () => boolean;
}

function identitiesMatch(expected: RuntimeProcessIdentity, actual: RuntimeProcessIdentity): boolean {
  return expected.pid === actual.pid
    && expected.executable === actual.executable
    && expected.startedAt === actual.startedAt
    && expected.processGroupId === actual.processGroupId;
}

function waitForMessage(
  subscribe: (listener: (message: SidecarMessage) => void) => () => void,
  predicate: (message: SidecarMessage) => boolean,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<SidecarMessage> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => finish(() => reject(new Error("Supervisor handshake timed out"))), timeoutMs);
    const unsubscribe = subscribe((message) => {
      if (message.type === "error") finish(() => reject(new Error(message.message ?? "Supervisor failed")));
      else if (predicate(message)) finish(() => resolve(message));
    });
    const aborted = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", aborted, { once: true });
    function finish(action: () => void): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      unsubscribe();
      action();
    }
  });
}

export interface DarwinProcessSupervisorOptions {
  readonly ownership: OwnershipStore;
  readonly inspector?: ProcessInspector;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
  readonly executable?: string;
  readonly electronRunAsNode?: boolean;
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly processGroupExists?: (processGroupId: number) => boolean;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export class DarwinProcessSupervisor implements ProcessSupervisor {
  readonly managedLaunchSupported: boolean;
  private readonly inspector: ProcessInspector;
  private readonly now: () => Date;
  private readonly executable: string;
  private readonly electronRunAsNode: boolean;
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly processGroupExists: (processGroupId: number) => boolean;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly live = new Map<number, LiveProcess>();

  constructor(private readonly options: DarwinProcessSupervisorOptions) {
    this.managedLaunchSupported = (options.platform ?? process.platform) === "darwin";
    this.inspector = options.inspector ?? new DarwinProcessInspector();
    this.now = options.now ?? (() => new Date());
    this.executable = options.executable ?? process.execPath;
    this.electronRunAsNode = options.electronRunAsNode ?? Boolean(process.versions.electron);
    this.signalProcess = options.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.processGroupExists = options.processGroupExists ?? ((processGroupId) => {
      try {
        process.kill(-processGroupId, 0);
        return true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw cause;
      }
    });
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async spawn(input: SpawnSupervisedProcessInput): Promise<SupervisedProcess> {
    if (!this.managedLaunchSupported) throw new Error("Managed process supervision is not available on this platform");
    input.signal.throwIfAborted();
    const nonce = randomBytes(32).toString("hex");
    const recordId = `${input.sessionId}.${input.role}`;
    let record: RuntimeOwnershipRecord = {
      formatVersion: 1,
      id: recordId,
      sessionId: input.sessionId,
      role: input.role,
      nonce,
      projectInstanceKey: input.projectInstanceKey,
      projectGeneration: input.projectGeneration,
      runtimeId: input.runtimeId,
      runtimePath: input.runtimePath,
      state: "reserved",
      createdAt: this.now().toISOString(),
      supervisor: null,
      process: null,
    };
    await this.options.ownership.put(record);

    const environment = this.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {};
    const sidecar = spawn(this.executable, ["--eval", POSIX_SUPERVISOR_SIDECAR_SOURCE], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    const listeners = new Set<(message: SidecarMessage) => void>();
    const subscribe = (listener: (message: SidecarMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const publish = (message: SidecarMessage) => {
      if (message.type === "log" && message.stream && message.data) {
        const chunk = Buffer.from(message.data, "base64");
        input.onOutput?.(message.stream, chunk);
        input.logs.write({ source: input.role, stream: message.stream, chunk });
      } else if (message.type === "diagnostic" && message.message) {
        input.logs.diagnostic(message.message);
      }
      for (const listener of listeners) listener(message);
    };
    const sidecarExit = new Promise<ProcessExit>((resolve) => {
      let resolved = false;
      const finish = (result: ProcessExit) => {
        if (resolved) return;
        resolved = true;
        resolve(result);
      };
      sidecar.once("exit", (code, signal) => finish({ code, signal }));
      sidecar.once("error", () => finish({ code: null, signal: null }));
    });
    sidecar.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        try {
          publish(JSON.parse(line) as SidecarMessage);
        } catch {
          input.logs.diagnostic("Supervisor emitted an invalid control message");
        }
        newline = stdout.indexOf("\n");
      }
    });
    sidecar.stderr.on("data", (chunk: Buffer) => input.logs.write({ source: "system", stream: "diagnostic", chunk }));

    const abort = () => sidecar.kill("SIGTERM");
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      const ready = await waitForMessage(subscribe, (message) => message.type === "ready", input.signal);
      const supervisorPid = ready.pid;
      if (!supervisorPid) throw new Error("Supervisor did not report its process id");
      const supervisorIdentity = await this.inspector.inspect(supervisorPid);
      if (!supervisorIdentity) throw new Error("Supervisor identity could not be verified");
      record = { ...record, supervisor: supervisorIdentity };
      await this.options.ownership.put(record);
      sidecar.stdin.write(`${JSON.stringify({
        type: "start",
        nonce,
        command: input.spec.command,
        args: input.spec.args,
        cwd: input.spec.cwd,
        environment: input.spec.environment,
      })}\n`);
      const started = await waitForMessage(subscribe, (message) => message.type === "started", input.signal);
      if (!started.pid) throw new Error("Supervisor did not report the target process id");
      const identity = await this.inspector.inspect(started.pid);
      if (!identity || identity.processGroupId !== identity.pid) {
        throw new Error("The target process group identity could not be verified");
      }
      record = { ...record, state: "running", process: identity };
      await this.options.ownership.put(record);

      let resolveExit: (exit: ProcessExit) => void = () => undefined;
      const exit = new Promise<ProcessExit>((resolve) => { resolveExit = resolve; });
      subscribe((message) => {
        if (message.type !== "cleaned" || settled) return;
        settled = true;
        resolveExit({ code: message.code ?? null, signal: message.signal ?? null });
      });
      void sidecarExit.then((sidecarResult) => {
        const groupCleanupReported = settled;
        if (!settled) {
          settled = true;
          resolveExit(sidecarResult);
        }
        if (groupCleanupReported) {
          this.live.delete(identity.pid);
          void this.options.ownership.remove(recordId);
        } else {
          input.logs.diagnostic("Supervisor exited before target cleanup; ownership was retained for recovery");
        }
      });
      const live: LiveProcess = {
        identity,
        role: input.role,
        exit,
        recordId,
        nonce,
        sidecar,
        exited: () => settled,
      };
      this.live.set(identity.pid, live);
      return live;
    } catch (cause) {
      sidecar.kill("SIGTERM");
      if (sidecar.exitCode === null && sidecar.signalCode === null) await sidecarExit.catch(() => undefined);
      await this.options.ownership.remove(recordId);
      throw cause;
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
  }

  async stop(process: SupervisedProcess, signal?: AbortSignal): Promise<void> {
    const live = this.live.get(process.identity.pid);
    if (!live || live.identity.startedAt !== process.identity.startedAt) return;
    signal?.throwIfAborted();
    const records = await this.options.ownership.list();
    const record = records.find((candidate) => candidate.id === live.recordId);
    if (record) await this.options.ownership.put({ ...record, state: "stopping" });
    if (!live.sidecar.stdin.destroyed) {
      live.sidecar.stdin.write(`${JSON.stringify({ type: "stop", nonce: live.nonce })}\n`);
    }
    if (!live.exited()) await live.exit;
    const actual = await this.inspector.inspect(process.identity.pid);
    let processGroupId = record?.process?.processGroupId ?? process.identity.processGroupId;
    if (actual) {
      if (!identitiesMatch(process.identity, actual) || actual.processGroupId !== actual.pid) {
        throw new Error("Process ownership changed before stop; no signal was sent");
      }
      processGroupId = actual.pid;
    }
    if (processGroupId !== null && this.processGroupExists(processGroupId)) {
      this.signalProcess(-processGroupId, "SIGTERM");
      await this.waitForGroupExit(processGroupId, signal);
      if (this.processGroupExists(processGroupId)) {
        throw new Error("Managed process group survived cleanup; ownership was retained for recovery");
      }
    } else if (actual) {
      throw new Error("Managed process group could not be verified; ownership was retained for recovery");
    }
    this.live.delete(process.identity.pid);
    await this.options.ownership.remove(live.recordId);
  }

  async recover(signal?: AbortSignal): Promise<readonly RecoveryOutcome[]> {
    const outcomes: RecoveryOutcome[] = [];
    const records = await this.options.ownership.list();
    if (!this.managedLaunchSupported) {
      return records.map((record) => ({ recordId: record.id, status: "ownership-mismatch" as const }));
    }
    for (const record of records) {
      signal?.throwIfAborted();
      if (record.process) {
        const actual = await this.inspector.inspect(record.process.pid);
        if (!actual) {
          const processGroupId = record.process.processGroupId;
          if (processGroupId !== null && this.processGroupExists(processGroupId)) {
            // A POSIX process-group id cannot be reused while any member of
            // that group remains alive. The recorded leader may have exited,
            // but the still-existing group is therefore still the one Larger
            // created and can be cleaned without trusting a reused PID.
            this.signalProcess(-processGroupId, "SIGTERM");
            await this.waitForGroupExit(processGroupId, signal);
            if (this.processGroupExists(processGroupId)) {
              outcomes.push({ recordId: record.id, status: "ownership-mismatch" });
              continue;
            }
            await this.options.ownership.remove(record.id);
            outcomes.push({ recordId: record.id, status: "cleaned" });
            continue;
          }
          await this.options.ownership.remove(record.id);
          outcomes.push({ recordId: record.id, status: "already-exited" });
          continue;
        }
        if (!identitiesMatch(record.process, actual) || actual.processGroupId !== actual.pid) {
          outcomes.push({ recordId: record.id, status: "ownership-mismatch" });
          continue;
        }
        this.signalProcess(-actual.pid, "SIGTERM");
        await this.waitForExit(actual, signal);
        await this.options.ownership.remove(record.id);
        outcomes.push({ recordId: record.id, status: "cleaned" });
        continue;
      }
      if (record.supervisor) {
        const actual = await this.inspector.inspect(record.supervisor.pid);
        if (actual && identitiesMatch(record.supervisor, actual)) this.signalProcess(actual.pid, "SIGTERM");
        else if (actual) {
          outcomes.push({ recordId: record.id, status: "ownership-mismatch" });
          continue;
        }
      }
      await this.options.ownership.remove(record.id);
      outcomes.push({ recordId: record.id, status: "already-exited" });
    }
    return outcomes;
  }

  private async waitForExit(identity: RuntimeProcessIdentity, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (!await this.inspector.inspect(identity.pid)) return;
      await this.delay(50);
    }
    const actual = await this.inspector.inspect(identity.pid);
    if (actual && identitiesMatch(identity, actual)) this.signalProcess(-identity.pid, "SIGKILL");
  }

  private async waitForGroupExit(processGroupId: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (!this.processGroupExists(processGroupId)) return;
      await this.delay(50);
    }
    if (!this.processGroupExists(processGroupId)) return;
    this.signalProcess(-processGroupId, "SIGKILL");
    const killDeadline = Date.now() + 1_000;
    while (Date.now() < killDeadline) {
      signal?.throwIfAborted();
      if (!this.processGroupExists(processGroupId)) return;
      await this.delay(25);
    }
  }
}
