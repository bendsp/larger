export type DesktopHostPhase = "idle" | "starting" | "ready" | "failed" | "stopping" | "stopped";

export interface DisposableDesktop {
  dispose(): Promise<void>;
}

export class DesktopHost<TDesktop extends DisposableDesktop> {
  private readonly createDesktop: () => Promise<TDesktop>;
  private readonly onPhase?: (phase: DesktopHostPhase, cause?: unknown) => void;
  private startPromise: Promise<TDesktop> | null = null;
  private stopPromise: Promise<void> | null = null;
  private desktop: TDesktop | null = null;
  private phaseValue: DesktopHostPhase = "idle";
  private stopRequested = false;

  constructor(options: {
    readonly createDesktop: () => Promise<TDesktop>;
    readonly onPhase?: (phase: DesktopHostPhase, cause?: unknown) => void;
  }) {
    this.createDesktop = options.createDesktop;
    this.onPhase = options.onPhase;
  }

  get phase(): DesktopHostPhase {
    return this.phaseValue;
  }

  current(): TDesktop | null {
    return this.desktop;
  }

  start(): Promise<TDesktop> {
    if (this.startPromise) return this.startPromise;
    if (this.phaseValue !== "idle") return Promise.reject(new Error(`Desktop host cannot start from ${this.phaseValue}`));
    this.transition("starting");
    this.startPromise = this.createDesktop().then(async (desktop) => {
      this.desktop = desktop;
      if (this.stopRequested) {
        await this.disposeDesktop();
        throw new Error("Desktop startup was cancelled by shutdown");
      }
      this.transition("ready");
      return desktop;
    }).catch((cause: unknown) => {
      if (!this.stopRequested && this.phaseValue !== "stopped") this.transition("failed", cause);
      throw cause;
    });
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopRequested = true;
    this.transition("stopping");
    this.stopPromise = (async () => {
      if (this.startPromise) await this.startPromise.catch(() => undefined);
      await this.disposeDesktop();
      this.transition("stopped");
    })();
    return this.stopPromise;
  }

  private async disposeDesktop(): Promise<void> {
    const desktop = this.desktop;
    this.desktop = null;
    if (desktop) await desktop.dispose();
  }

  private transition(phase: DesktopHostPhase, cause?: unknown): void {
    this.phaseValue = phase;
    this.onPhase?.(phase, cause);
  }
}
