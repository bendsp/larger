import type { RuntimeLogEntry, RuntimeLogWindow } from "../../src/runtime-contracts.js";

export interface RuntimeLogChunk {
  readonly source: RuntimeLogEntry["source"];
  readonly stream: RuntimeLogEntry["stream"];
  readonly chunk: string | Buffer;
}

export interface RedactingLogBufferOptions {
  readonly limit?: number;
  readonly maxLineBytes?: number;
  readonly now?: () => Date;
}

interface PendingStream {
  text: string;
  discardingOversizedLine: boolean;
}

export class RedactingLogBuffer {
  private readonly limit: number;
  private readonly maxLineBytes: number;
  private readonly now: () => Date;
  private readonly secrets = new Set<string>();
  private readonly entries: RuntimeLogEntry[] = [];
  private readonly pending = new Map<string, PendingStream>();
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  private truncated = false;

  constructor(options: RedactingLogBufferOptions = {}) {
    this.limit = options.limit ?? 500;
    this.maxLineBytes = options.maxLineBytes ?? 64 * 1024;
    this.now = options.now ?? (() => new Date());
  }

  addSecrets(values: readonly string[]): void {
    for (const value of values) {
      if (!value) continue;
      this.secrets.add(value);
      const encoded = encodeURIComponent(value);
      if (encoded !== value) this.secrets.add(encoded);
    }
  }

  write(input: RuntimeLogChunk): void {
    const key = `${input.source}:${input.stream}`;
    const state = this.pending.get(key) ?? { text: "", discardingOversizedLine: false };
    let incoming = typeof input.chunk === "string" ? input.chunk : input.chunk.toString("utf8");
    while (incoming.length > 0) {
      if (state.discardingOversizedLine) {
        const newline = incoming.indexOf("\n");
        if (newline < 0) return void this.pending.set(key, state);
        state.discardingOversizedLine = false;
        incoming = incoming.slice(newline + 1);
        continue;
      }
      state.text += incoming;
      incoming = "";
      let newline = state.text.indexOf("\n");
      while (newline >= 0) {
        const line = state.text.slice(0, newline).replace(/\r$/, "");
        state.text = state.text.slice(newline + 1);
        this.push(input.source, input.stream, line);
        newline = state.text.indexOf("\n");
      }
      if (Buffer.byteLength(state.text) > this.maxLineBytes) {
        state.text = "";
        state.discardingOversizedLine = true;
        this.push(input.source, "diagnostic", "[oversized log line omitted]");
      }
    }
    this.pending.set(key, state);
  }

  flush(): void {
    for (const [key, state] of this.pending) {
      if (state.text) {
        const [source, stream] = key.split(":") as [RuntimeLogEntry["source"], RuntimeLogEntry["stream"]];
        this.push(source, stream, state.text.replace(/\r$/, ""));
      }
    }
    this.pending.clear();
  }
  clear(): void {
    this.secrets.clear();
    this.entries.length = 0;
    this.pending.clear();
    this.nextId = 1;
    this.truncated = false;
    for (const listener of this.listeners) listener();
  }

  diagnostic(message: string): void {
    this.push("system", "diagnostic", message);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  window(): RuntimeLogWindow {
    return {
      entries: this.entries.map((entry) => ({ ...entry })),
      earliestId: this.entries[0]?.id ?? null,
      latestId: this.entries.at(-1)?.id ?? null,
      retained: this.entries.length,
      limit: this.limit,
      truncated: this.truncated,
    };
  }

  redactText(message: string): string {
    let redacted = message;
    for (const secret of [...this.secrets].sort((left, right) => right.length - left.length)) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
    return redacted;
  }

  private push(source: RuntimeLogEntry["source"], stream: RuntimeLogEntry["stream"], message: string): void {
    if (!message) return;
    const redacted = this.redactText(message);
    const bounded = Buffer.byteLength(redacted) > this.maxLineBytes || redacted.length > 65_536
      ? "[oversized log line omitted]"
      : redacted;
    this.entries.push({
      id: this.nextId++,
      timestamp: this.now().toISOString(),
      source,
      stream,
      message: bounded,
    });
    while (this.entries.length > this.limit) {
      this.entries.shift();
      this.truncated = true;
    }
    for (const listener of this.listeners) listener();
  }
}
