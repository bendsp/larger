import { useEffect, useRef, useState, type FormEvent } from "react";
import { ExternalLinkIcon, MonitorPlayIcon, RefreshCwIcon } from "lucide-react";
import type { RuntimeSession } from "@/runtime-contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";

function validRoute(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && value.length <= 2048;
}

export function RuntimeCanvasWorkspace({
  generation,
  session,
  suspended = false,
  onOpenServers,
}: {
  generation: number;
  session: RuntimeSession | null;
  suspended?: boolean;
  onOpenServers: () => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const routeInput = useRef<HTMLInputElement>(null);
  const [route, setRoute] = useState(session?.endpoint.route ?? "/");
  const [problem, setProblem] = useState<string | null>(null);
  const surfaceId = session?.surface.id ?? null;

  useEffect(() => {
    setRoute(session?.endpoint.route ?? "/");
  }, [session?.endpoint.route, surfaceId]);

  useEffect(() => {
    const bridge = window.larger?.canvas;
    const element = mount.current;
    if (!bridge || !element || !surfaceId || suspended) {
      if (bridge && surfaceId) bridge.hide(generation, surfaceId);
      return;
    }
    let disposed = false;
    const updateBounds = () => {
      if (disposed) return;
      const bounds = element.getBoundingClientRect();
      bridge.setBounds(generation, surfaceId, {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
    };
    const observer = new ResizeObserver(updateBounds);
    observer.observe(element);
    window.addEventListener("resize", updateBounds);
    const unsubscribe = bridge.onNavigation((navigation) => {
      if (navigation.generation === generation && navigation.surfaceId === surfaceId) {
        setRoute(navigation.route);
      }
    });
    const unsubscribeFocus = bridge.onFocusReturn((navigation) => {
      if (navigation.generation === generation && navigation.surfaceId === surfaceId) routeInput.current?.focus();
    });
    updateBounds();
    void bridge.load(generation, surfaceId).then(() => {
      if (!disposed) {
        setProblem(null);
        updateBounds();
        bridge.show(generation, surfaceId);
      }
    }).catch((cause: unknown) => {
      if (!disposed) setProblem(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeFocus();
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
      bridge.hide(generation, surfaceId);
    };
  }, [generation, surfaceId, suspended]);

  if (!session) {
    return (
      <Empty className="h-full rounded-none">
        <EmptyHeader>
          <EmptyMedia variant="icon"><MonitorPlayIcon /></EmptyMedia>
          <EmptyTitle>No active preview</EmptyTitle>
          <EmptyDescription>Start a managed runtime or attach a preview-only local server first.</EmptyDescription>
        </EmptyHeader>
        <Button onClick={onOpenServers}><ExternalLinkIcon data-icon="inline-start" />Open servers</Button>
      </Empty>
    );
  }

  const navigate = async (nextRoute: string) => {
    if (!validRoute(nextRoute)) {
      setProblem("Enter a project route beginning with a single slash.");
      return;
    }
    try {
      await window.larger?.canvas.navigate(generation, session.surface.id, nextRoute);
      setProblem(null);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void navigate(route);
  };

  return (
    <div className="flex size-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <form className="min-w-0 flex-1" onSubmit={submit}>
          <InputGroup>
            <InputGroupInput
              ref={routeInput}
              aria-label="Canvas route"
              value={route}
              onChange={(event) => setRoute(event.target.value)}
              spellCheck={false}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton type="submit">Go</InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => window.larger?.canvas.focus(generation, session.surface.id)}
        >
          Focus preview
        </Button>
        <Badge variant="outline">{session.surface.writable ? "Editable" : "Preview only"}</Badge>
        <Button size="icon-sm" variant="ghost" aria-label="Reload canvas" onClick={() => void navigate(route)}>
          <RefreshCwIcon />
        </Button>
      </div>
      {problem && (
        <Alert variant="destructive" className="m-3 shrink-0">
          <MonitorPlayIcon />
          <AlertTitle>Canvas unavailable</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      {!window.larger?.canvas && (
        <Alert className="m-3 shrink-0">
          <MonitorPlayIcon />
          <AlertTitle>Desktop canvas required</AlertTitle>
          <AlertDescription>The native canvas surface is available in the Larger desktop app.</AlertDescription>
        </Alert>
      )}
      <div ref={mount} className="relative min-h-0 flex-1 bg-muted/20" />
    </div>
  );
}
