import path from "node:path";

export const OPEN_PROJECT_ARGUMENT = "--larger-open-project";

export type LaunchIntentSource = "initial" | "second-instance" | "open-file";

export interface OpenProjectLaunchIntent {
  readonly kind: "open-project";
  readonly path: string;
  readonly source: LaunchIntentSource;
}

export type LaunchIntent = OpenProjectLaunchIntent;

export type LaunchIntentHandler = (intent: LaunchIntent) => Promise<void> | void;

function normalizedAbsolutePath(value: string): string | null {
  if (value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) return null;
  return path.normalize(value);
}

export function launchIntentFromPath(value: string, source: LaunchIntentSource): LaunchIntent | null {
  const normalized = normalizedAbsolutePath(value);
  return normalized ? { kind: "open-project", path: normalized, source } : null;
}

export function parseLaunchIntent(argv: readonly string[], source: "initial" | "second-instance"): LaunchIntent | null {
  let selected: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === OPEN_PROJECT_ARGUMENT) {
      selected = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argument.startsWith(`${OPEN_PROJECT_ARGUMENT}=`)) {
      selected = argument.slice(OPEN_PROJECT_ARGUMENT.length + 1);
    }
  }
  return selected ? launchIntentFromPath(selected, source) : null;
}

export class LaunchIntentRouter {
  private handler: LaunchIntentHandler | null = null;
  private pending: LaunchIntent | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private stopped = false;

  submit(intent: LaunchIntent | null): void {
    if (!intent || this.stopped) return;
    if (!this.handler) {
      this.pending = intent;
      return;
    }
    this.enqueue(intent);
  }

  attach(handler: LaunchIntentHandler): void {
    if (this.stopped) throw new Error("Launch intent router is stopped");
    if (this.handler) throw new Error("Launch intent router already has a handler");
    this.handler = handler;
    const pending = this.pending;
    this.pending = null;
    if (pending) this.enqueue(pending);
  }

  detach(): void {
    this.handler = null;
  }

  async idle(): Promise<void> {
    await this.operationTail;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pending = null;
    this.handler = null;
    await this.operationTail;
  }

  private enqueue(intent: LaunchIntent): void {
    const handler = this.handler;
    if (!handler) {
      this.pending = intent;
      return;
    }
    const run = async () => {
      if (this.stopped || this.handler !== handler) return;
      await handler(intent);
    };
    this.operationTail = this.operationTail.then(run, run);
  }
}
