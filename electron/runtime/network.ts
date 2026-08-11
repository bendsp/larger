import net from "node:net";
import { createHash } from "node:crypto";
import type { RuntimeDiscoveryCandidate, RuntimeEndpoint } from "../../src/runtime-contracts.js";
import { loopbackHttpUrlProblem } from "../../src/runtime-network.js";

export class RuntimeNetworkError extends Error {
  override readonly name: string = "RuntimeNetworkError";
}

export class PortUnavailableError extends RuntimeNetworkError {
  override readonly name: string = "PortUnavailableError";
}

export function parseLoopbackHttpUrl(value: string): URL {
  const problem = loopbackHttpUrlProblem(value);
  if (problem) throw new RuntimeNetworkError(problem);
  return new URL(value);
}

export function attachedEndpoint(url: URL): RuntimeEndpoint {
  return {
    origin: url.origin,
    route: `${url.pathname}${url.search}`,
    displayUrl: url.toString(),
    portAllocation: null,
  };
}

export interface PortAllocator {
  allocate(preferred: number, signal: AbortSignal): Promise<number>;
}

async function canBind(port: number, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return await new Promise<boolean>((resolve, reject) => {
    const server = net.createServer();
    const abort = () => server.close(() => reject(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    server.once("error", () => {
      signal.removeEventListener("abort", abort);
      resolve(false);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => {
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(true);
      });
    });
  });
}

export class LoopbackPortAllocator implements PortAllocator {
  constructor(private readonly attempts = 20) {}

  async allocate(preferred: number, signal: AbortSignal): Promise<number> {
    for (let offset = 0; offset < this.attempts; offset += 1) {
      const candidate = preferred + offset;
      if (candidate > 65_535) break;
      if (await canBind(candidate, signal)) return candidate;
    }
    throw new PortUnavailableError(`No loopback port is available from ${preferred}.`);
  }
}

export interface ReadinessProbeInput {
  readonly url: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface ReadinessProbe {
  wait(input: ReadinessProbeInput): Promise<void>;
}

export interface FetchReadinessProbeOptions {
  readonly fetch?: typeof fetch;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export class FetchReadinessProbe implements ReadinessProbe {
  private readonly fetch: typeof fetch;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(options: FetchReadinessProbeOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.intervalMs = options.intervalMs ?? 250;
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? abortableDelay;
  }

  async wait(input: ReadinessProbeInput): Promise<void> {
    const expected = parseLoopbackHttpUrl(input.url);
    const deadline = this.now() + input.timeoutMs;
    let lastFailure = "did not respond";
    while (this.now() < deadline) {
      input.signal.throwIfAborted();
      const remaining = Math.max(1, deadline - this.now());
      const attempt = new AbortController();
      const timeout = setTimeout(() => attempt.abort(new Error("Readiness request timed out")), Math.min(2_000, remaining));
      const abort = () => attempt.abort(input.signal.reason);
      input.signal.addEventListener("abort", abort, { once: true });
      try {
        const response = await this.fetch(expected, { signal: attempt.signal, redirect: "manual" });
        if (response.status >= 200 && response.status < 300 || response.status >= 400 && response.status < 500) {
          await response.body?.cancel();
          return;
        }
        lastFailure = response.status >= 300 && response.status < 400
          ? "attempted a redirect"
          : `returned HTTP ${response.status}`;
        await response.body?.cancel();
      } catch (cause) {
        if (input.signal.aborted) throw input.signal.reason;
        lastFailure = cause instanceof Error ? cause.message : String(cause);
      } finally {
        clearTimeout(timeout);
        input.signal.removeEventListener("abort", abort);
      }
      await this.delay(Math.min(this.intervalMs, Math.max(1, deadline - this.now())), input.signal);
    }
    throw new RuntimeNetworkError(`Runtime readiness ${lastFailure}.`);
  }
}

export interface RuntimeDiscoveryProvider {
  discover(signal: AbortSignal): Promise<readonly RuntimeDiscoveryCandidate[]>;
}

export class EmptyRuntimeDiscoveryProvider implements RuntimeDiscoveryProvider {
  async discover(signal: AbortSignal): Promise<readonly RuntimeDiscoveryCandidate[]> {
    signal.throwIfAborted();
    return [];
  }
}

export interface LoopbackRuntimeDiscoveryOptions {
  readonly ports?: readonly number[];
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_DISCOVERY_PORTS = [3000, 3001, 4173, 4200, 4310, 4321, 5000, 5173, 5174, 8000, 8080, 8787] as const;

export class LoopbackRuntimeDiscoveryProvider implements RuntimeDiscoveryProvider {
  private readonly ports: readonly number[];
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: LoopbackRuntimeDiscoveryOptions = {}) {
    this.ports = [...new Set(options.ports ?? DEFAULT_DISCOVERY_PORTS)].filter(
      (port) => Number.isInteger(port) && port > 0 && port <= 65_535,
    );
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 350;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 5_000) {
      throw new Error("Discovery timeout must be between 1 and 5000 milliseconds");
    }
  }

  async discover(signal: AbortSignal): Promise<readonly RuntimeDiscoveryCandidate[]> {
    signal.throwIfAborted();
    const candidates = await Promise.all(this.ports.map(async (port): Promise<RuntimeDiscoveryCandidate | null> => {
      const url = `http://127.0.0.1:${port}/`;
      const attempt = new AbortController();
      const timeout = setTimeout(() => attempt.abort(new Error("Discovery request timed out")), this.timeoutMs);
      const abort = () => attempt.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      try {
        const response = await this.fetch(url, { signal: attempt.signal, redirect: "manual" });
        await response.body?.cancel();
        return {
          id: createHash("sha256").update(url).digest("hex").slice(0, 24),
          url,
          processId: null,
          label: `Local server on port ${port}`,
        };
      } catch {
        if (signal.aborted) throw signal.reason;
        return null;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      }
    }));
    signal.throwIfAborted();
    return candidates.filter((candidate): candidate is RuntimeDiscoveryCandidate => candidate !== null);
  }
}
