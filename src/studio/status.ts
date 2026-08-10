import type { SessionPhase } from "@/contracts";

const LABELS: Record<SessionPhase, string> = {
  idle: "Stopped",
  preparing: "Preparing",
  "starting-target": "Starting server",
  "starting-adapter": "Attaching editor",
  ready: "Running",
  stopping: "Stopping",
  error: "Error",
};

export function phaseLabel(phase: SessionPhase): string {
  return LABELS[phase];
}
