export class ShutdownDeadlineError extends Error {
  override readonly name = "ShutdownDeadlineError";
}

export const SHUTDOWN_DEADLINE_MS = 15_000;

export function shutdownExitAction(cause: unknown): "exit" | "quit" {
  return cause instanceof ShutdownDeadlineError ? "exit" : "quit";
}

export async function runWithShutdownDeadline(
  operation: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ShutdownDeadlineError("Desktop shutdown exceeded its deadline")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
