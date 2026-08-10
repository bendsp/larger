import type { ChildProcess } from "node:child_process";

const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export async function terminateProcess(child: ChildProcess | null): Promise<boolean> {
  if (!child?.pid || child.exitCode !== null) return true;
  const exitPromise = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  try {
    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    child.kill("SIGTERM");
  }

  const exited = await Promise.race([
    exitPromise,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (exited || child.exitCode !== null || !child.pid) return true;

  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
  const killed = await Promise.race([
    exitPromise,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  return killed || child.exitCode !== null;
}
