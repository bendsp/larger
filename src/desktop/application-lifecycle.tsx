import { AlertTriangleIcon, PowerIcon, RefreshCwIcon } from "lucide-react";
import type { ApplicationSnapshot } from "./application-contract";
import { applicationProblem } from "./application-state";
import type { ApplicationLifecycleController } from "./use-application-lifecycle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";

const phaseContent = {
  starting: {
    title: "Starting Larger",
    description: "Preparing the desktop services for your project.",
  },
  recovering: {
    title: "Restoring your workspace",
    description: "Recovering the last safe desktop state.",
  },
  "shutting-down": {
    title: "Closing Larger",
    description: "Finishing active work before the app closes.",
  },
} as const;

export function ApplicationLifecycleScreen({ lifecycle }: { lifecycle: ApplicationLifecycleController }) {
  const phase = lifecycle.snapshot?.phase;
  const transient = phase === "starting" || phase === "recovering" || phase === "shutting-down";

  if (!lifecycle.snapshot && !lifecycle.problem) {
    return <LifecycleProgress title="Connecting to Larger" description="Waiting for the desktop service." />;
  }
  if (transient) {
    const content = phaseContent[phase];
    return <LifecycleProgress title={content.title} description={content.description} />;
  }

  const problem = lifecycle.problem ?? (lifecycle.snapshot ? applicationProblem(lifecycle.snapshot) : null) ?? {
    code: "unavailable" as const,
    message: "The desktop service is unavailable.",
    retryable: true,
  };

  return (
    <main className="grid h-screen place-items-center bg-muted/30 p-6" data-testid="application-lifecycle">
      <Empty className="max-w-lg border bg-background shadow-sm">
        <EmptyHeader>
          <EmptyMedia variant="icon"><AlertTriangleIcon /></EmptyMedia>
          <EmptyTitle role="heading" aria-level={1}>Larger could not start</EmptyTitle>
          <EmptyDescription>{problem.message}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>Desktop service unavailable</AlertTitle>
            <AlertDescription>Problem code: <span className="font-mono">{problem.code}</span></AlertDescription>
          </Alert>
          <div className="flex flex-wrap justify-center gap-2">
            {problem.retryable && lifecycle.bridgeAvailable && (
              <Button autoFocus disabled={lifecycle.busy} onClick={() => void lifecycle.retry()}>
                {lifecycle.operation === "retrying" ? <Spinner role="presentation" aria-hidden="true" /> : <RefreshCwIcon data-icon="inline-start" />}
                Try again
              </Button>
            )}
            {lifecycle.bridgeAvailable && (
              <Button variant="outline" disabled={lifecycle.busy} onClick={() => void lifecycle.quit()}>
                {lifecycle.operation === "quitting" ? <Spinner role="presentation" aria-hidden="true" /> : <PowerIcon data-icon="inline-start" />}
                Quit
              </Button>
            )}
          </div>
        </EmptyContent>
      </Empty>
    </main>
  );
}

function LifecycleProgress({ title, description }: { title: string; description: string }) {
  return (
    <main
      className="grid h-screen place-items-center bg-background"
      aria-busy="true"
      data-testid="application-lifecycle"
    >
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Spinner role="presentation" aria-hidden="true" /></EmptyMedia>
          <EmptyTitle role="heading" aria-level={1}>{title}</EmptyTitle>
          <EmptyDescription role="status" aria-live="polite">{description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </main>
  );
}

export function ApplicationDegradedBanner({
  snapshot,
  problem: externalProblem,
  busy,
  onRetry,
}: {
  snapshot: ApplicationSnapshot;
  problem?: ApplicationLifecycleController["problem"];
  busy: boolean;
  onRetry: () => void;
}) {
  const problem = externalProblem ?? applicationProblem(snapshot);
  const affected = Object.entries(snapshot.services)
    .filter(([, service]) => service.status === "degraded" || service.status === "unavailable")
    .map(([name]) => name.replaceAll("-", " "));

  return (
    <div className="shrink-0 border-b bg-background px-4 py-2">
      <Alert role="status" aria-live="polite">
        <AlertTriangleIcon />
        <AlertTitle>Running with limited features</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          <span>{problem?.message ?? "Some desktop services are unavailable."}{affected.length > 0 ? ` Affected: ${affected.join(", ")}.` : ""}</span>
          {problem?.retryable !== false && (
            <Button size="xs" variant="outline" disabled={busy} onClick={onRetry}>
              {busy ? <Spinner role="presentation" aria-hidden="true" /> : <RefreshCwIcon data-icon="inline-start" />}
              Try again
            </Button>
          )}
        </AlertDescription>
      </Alert>
    </div>
  );
}
