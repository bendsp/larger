const FATAL_STARTUP_TITLE = "Larger could not start";
const FATAL_STARTUP_MESSAGE = "Larger could not start its desktop services. Please restart the app. If the problem continues, check the application logs.";

export interface FatalStartupReporterOptions {
  readonly showErrorBox: (title: string, message: string) => void;
  readonly logPrivateCause: (message: string, cause: unknown) => void;
  readonly quit: () => void;
}

export interface FatalStartupReporter {
  report(cause: unknown): void;
}

export function createFatalStartupReporter(options: FatalStartupReporterOptions): FatalStartupReporter {
  let reported = false;
  return {
    report(cause) {
      options.logPrivateCause(FATAL_STARTUP_TITLE, cause);
      if (reported) return;
      reported = true;
      try {
        options.showErrorBox(FATAL_STARTUP_TITLE, FATAL_STARTUP_MESSAGE);
      } finally {
        options.quit();
      }
    },
  };
}

export function runPreReadyStartup<T>(operation: () => T, reporter: FatalStartupReporter): T | undefined {
  try {
    return operation();
  } catch (cause) {
    reporter.report(cause);
    return undefined;
  }
}

export async function runDesktopStartup<T>(
  operation: () => Promise<T>,
  reporter: FatalStartupReporter,
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (cause) {
    reporter.report(cause);
    return undefined;
  }
}
