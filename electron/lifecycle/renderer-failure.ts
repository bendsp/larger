export interface RendererFailureReporter {
  report(cause: unknown): Promise<void>;
}

export function createRendererFailureReporter(options: {
  readonly log: (cause: unknown) => Promise<void> | void;
  readonly prompt: () => Promise<"retry" | "quit">;
  readonly retry: () => Promise<void> | void;
  readonly quit: () => Promise<void> | void;
}): RendererFailureReporter {
  let pending: Promise<void> | null = null;
  return {
    report(cause) {
      if (pending) return pending;
      pending = (async () => {
        await options.log(cause);
        const action = await options.prompt();
        if (action === "retry") await options.retry();
        else await options.quit();
      })().finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}
