import {
  type CSSProperties,
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { CircleStopIcon, GitBranchIcon, PlayIcon } from "lucide-react";
import type {
  EditorAdapterDescriptor,
  ProjectSummary,
  SessionSnapshot,
  SessionStartOptions,
} from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { toast } from "@/components/ui/toast";
import { CanvasWorkspace, AssetsWorkspace, ComponentsWorkspace, DesignSystemWorkspace, RoutesWorkspace, ServersWorkspace } from "@/studio/workspaces";
import { Inspector } from "@/studio/inspector";
import { StudioNavigation } from "@/studio/navigation";
import type { StudioSelection, Viewport, Workspace } from "@/studio/types";

const EMPTY_ADAPTER: EditorAdapterDescriptor = {
  id: "",
  name: "Editor adapter",
  version: "",
  supports: { platforms: [], runtimes: [] },
  capabilities: {
    selection: "unavailable",
    sourceNavigation: "unavailable",
    textEditing: "unavailable",
    styleEditing: "unavailable",
    layoutEditing: "unavailable",
    history: "unavailable",
  },
  maxClients: null,
};

const INITIAL_SESSION: SessionSnapshot = {
  phase: "idle",
  adapter: EMPTY_ADAPTER,
  server: {
    mode: "managed",
    configured: { command: [], host: "127.0.0.1", preferredPort: 3000 },
    active: null,
  },
  surface: null,
  error: null,
  logs: [],
  changes: [],
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

function reportError(error: unknown): void {
  toast.add({
    type: "error",
    title: "Session error",
    description: error instanceof Error ? error.message : String(error),
  });
}

function useCanvasBounds(ref: RefObject<HTMLDivElement | null>, enabled: boolean) {
  useEffect(() => {
    const bridge = window.largerCanvas;
    const element = ref.current;
    if (!bridge || !element || !enabled) {
      if (!enabled) bridge?.hide();
      return;
    }

    bridge.show();

    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        bridge.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [enabled, ref]);
}

function parseServerAddress(address: string): SessionStartOptions {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("Enter a full local address such as http://127.0.0.1:3000");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("The managed server address must use HTTP on localhost or 127.0.0.1");
  }
  const preferredPort = Number(url.port);
  if (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65_535) {
    throw new Error("The managed server address needs a port between 1024 and 65535");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The managed server address cannot include a path, query, or fragment");
  }
  return { host: url.hostname as SessionStartOptions["host"], preferredPort };
}

export function App() {
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [session, setSession] = useState<SessionSnapshot>(INITIAL_SESSION);
  const [workspace, setWorkspace] = useState<Workspace>("components");
  const [selection, setSelection] = useState<StudioSelection>(null);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [route, setRoute] = useState("/");
  const [routeDraft, setRouteDraft] = useState("/");
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [serverAddress, setServerAddress] = useState("http://127.0.0.1:3000");
  const [apiReady, setApiReady] = useState(false);
  const [sessionConfigReady, setSessionConfigReady] = useState(false);
  const canvasMountRef = useRef<HTMLDivElement>(null);
  const loadedSurfaceRef = useRef<string | null>(null);
  const requestedRouteRef = useRef<string | null>(null);
  const serverAddressHydratedRef = useRef(false);
  const lastSessionErrorRef = useRef<string | null>(null);
  const surfaceUrl = session.surface?.kind === "web-url" ? session.surface.url : null;
  const canvasReady = session.phase === "ready" && Boolean(surfaceUrl);
  const canvasVisible = workspace === "canvas" && canvasReady;
  useCanvasBounds(canvasMountRef, canvasVisible);

  useEffect(() => {
    let cancelled = false;
    let retry = 0;
    let lastReportedError: string | null = null;
    const loadProject = async () => {
      try {
        const projectValue = await fetchJson<ProjectSummary>("/api/project");
        if (!cancelled) {
          setProject(projectValue);
          setRoute(projectValue.entryRoute);
          setRouteDraft(projectValue.entryRoute);
          setApiReady(true);
          lastReportedError = null;
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== lastReportedError) {
            reportError(error);
            lastReportedError = message;
          }
          retry = window.setTimeout(loadProject, 1_000);
        }
      }
    };
    void loadProject();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let lastReportedError: string | null = null;
    const poll = async () => {
      try {
        const snapshot = await fetchJson<SessionSnapshot>("/api/session");
        if (!cancelled) {
          setSession(snapshot);
          if (!serverAddressHydratedRef.current) {
            const { host, preferredPort } = snapshot.server.configured;
            setServerAddress(`http://${host}:${preferredPort}`);
            serverAddressHydratedRef.current = true;
          }
          setSessionConfigReady(true);
          lastReportedError = null;
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== lastReportedError) {
            reportError(error);
            lastReportedError = message;
          }
        }
      }
    };
    void poll();
    const interval = window.setInterval(poll, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (workspace !== "canvas" || !canvasReady || !surfaceUrl || !window.largerCanvas) {
      if (workspace !== "canvas") window.largerCanvas?.hide();
      if (!canvasReady) {
        loadedSurfaceRef.current = null;
        window.largerCanvas?.hide();
      }
      return;
    }
    if (loadedSurfaceRef.current === surfaceUrl) {
      const requestedRoute = requestedRouteRef.current;
      if (!requestedRoute) return;
      requestedRouteRef.current = null;
      const requestedUrl = new URL(requestedRoute, `${surfaceUrl}/`).toString();
      void window.largerCanvas.navigate(requestedUrl).catch(reportError);
      return;
    }
    requestedRouteRef.current = null;
    loadedSurfaceRef.current = surfaceUrl;
    const initialUrl = new URL(route, `${surfaceUrl}/`).toString();
    void window.largerCanvas.load(initialUrl).catch(reportError);
  }, [canvasReady, route, surfaceUrl, workspace]);

  useEffect(() => window.largerCanvas?.onNavigation((url) => {
    setCurrentUrl(url);
    if (!surfaceUrl) return;
    const current = new URL(url);
    if (current.origin !== new URL(surfaceUrl).origin) return;
    const relative = `${current.pathname}${current.search}${current.hash}`;
    setRoute(relative);
    setRouteDraft(relative);
  }), [surfaceUrl]);

  useEffect(() => {
    if (!session.error) {
      lastSessionErrorRef.current = null;
      return;
    }
    if (lastSessionErrorRef.current === session.error) return;
    lastSessionErrorRef.current = session.error;
    reportError(session.error);
  }, [session.error]);

  const start = useCallback(async () => {
    try {
      if (!sessionConfigReady) throw new Error("Server configuration is still loading");
      const options = parseServerAddress(serverAddress);
      setSession((current) => ({ ...current, phase: "preparing", error: null }));
      const health = await fetchJson<{ capability: string }>("/api/health");
      const snapshot = await fetchJson<SessionSnapshot>("/api/session/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Larger-Capability": health.capability,
        },
        body: JSON.stringify(options),
      });
      setSession(snapshot);
    } catch (error) {
      reportError(error);
    }
  }, [serverAddress, sessionConfigReady]);

  const stop = useCallback(async () => {
    window.largerCanvas?.hide();
    loadedSurfaceRef.current = null;
    requestedRouteRef.current = null;
    setCurrentUrl(null);
    setSession((current) => ({ ...current, phase: "stopping" }));
    try {
      const health = await fetchJson<{ capability: string }>("/api/health");
      setSession(await fetchJson<SessionSnapshot>("/api/session/stop", {
        method: "POST",
        headers: { "X-Larger-Capability": health.capability },
      }));
    } catch (error) {
      reportError(error);
    }
  }, []);

  const changeWorkspace = useCallback((next: Workspace) => {
    setWorkspace(next);
    setSelection(next === "servers" ? { kind: "server" } : null);
  }, []);

  const navigateToRoute = useCallback((nextRoute: string) => {
    const normalized = nextRoute.startsWith("/") ? nextRoute : `/${nextRoute}`;
    requestedRouteRef.current = normalized;
    setRoute(normalized);
    setRouteDraft(normalized);
    setWorkspace("canvas");
    setSelection(null);
  }, []);

  const submitRoute = (event: FormEvent) => {
    event.preventDefault();
    navigateToRoute(routeDraft);
  };

  const renderWorkspace = () => {
    if (workspace === "components") return <ComponentsWorkspace project={project} selection={selection} onSelect={setSelection} />;
    if (workspace === "design-system") return <DesignSystemWorkspace project={project} selection={selection} onSelect={setSelection} />;
    if (workspace === "assets") return <AssetsWorkspace project={project} selection={selection} onSelect={setSelection} />;
    if (workspace === "routes") return <RoutesWorkspace project={project} selection={selection} onSelect={setSelection} onOpen={navigateToRoute} />;
    if (workspace === "servers") return (
      <ServersWorkspace
        session={session}
        address={serverAddress}
        onAddressChange={setServerAddress}
        canStart={Boolean(project && apiReady && sessionConfigReady)}
        onStart={start}
        onStop={stop}
      />
    );
    return (
      <CanvasWorkspace
        project={project}
        session={session}
        canvasMountRef={canvasMountRef}
        nativeAvailable={Boolean(window.largerCanvas)}
        routeDraft={routeDraft}
        viewport={viewport}
        onRouteDraftChange={setRouteDraft}
        onRouteSubmit={submitRoute}
        onViewportChange={setViewport}
        onReload={() => {
          if (!surfaceUrl || !window.largerCanvas) return;
          const url = currentUrl ?? new URL(route, `${surfaceUrl}/`).toString();
          void window.largerCanvas.navigate(url).catch(reportError);
        }}
        canStart={Boolean(project && apiReady && sessionConfigReady)}
        onStart={start}
        onStop={stop}
      />
    );
  };

  const isBusy = ["preparing", "starting-target", "starting-adapter", "stopping"].includes(session.phase);
  const isStarting = ["preparing", "starting-target", "starting-adapter"].includes(session.phase);
  const isRunning = session.phase === "ready";

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <SidebarProvider
        className="min-h-0 flex-1 flex-col"
        style={{
          "--sidebar-width": "16rem",
          "--sidebar-width-icon": "3rem",
        } as CSSProperties}
      >
        <header className="app-drag flex min-h-12 items-center border-b bg-background px-4 pl-20">
          <div className="app-no-drag flex items-center gap-2">
            <SidebarTrigger />
            <span className="text-sm font-semibold tracking-tight">Larger</span>
            <span className="text-xs text-muted-foreground">/</span>
            <span className="max-w-64 truncate text-xs text-muted-foreground">{project?.name ?? "reading project"}</span>
          </div>
          <div className="ml-auto flex items-center gap-2 app-no-drag">
            {project && (
              <Badge variant="outline" className="max-w-48 gap-1.5 font-mono text-[10px]">
                <GitBranchIcon data-icon="inline-start" />{project.git.branch}
              </Badge>
            )}
            {isRunning || isStarting || session.phase === "stopping" ? (
              <Button size="sm" variant="outline" disabled={session.phase === "stopping"} onClick={stop}>
                <CircleStopIcon data-icon="inline-start" />
                {session.phase === "stopping" ? "Stopping" : isStarting ? "Cancel" : "Stop"}
              </Button>
            ) : (
              <Button size="sm" disabled={!project || !apiReady || !sessionConfigReady || isBusy} onClick={start}>
                <PlayIcon data-icon="inline-start" />{isBusy ? "Starting" : "Start"}
              </Button>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <StudioNavigation project={project} phase={session.phase} workspace={workspace} onWorkspaceChange={changeWorkspace} />
          <ResizablePanelGroup
            id="studio-layout"
            orientation="horizontal"
            resizeTargetMinimumSize={{ coarse: 28, fine: 12 }}
            className="min-h-0"
          >
            <ResizablePanel id="workspace" defaultSize="74%" minSize={520}>
              <section className="h-full min-h-0 bg-background">{renderWorkspace()}</section>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel id="inspector" defaultSize="26%" minSize={250} maxSize={420} groupResizeBehavior="preserve-pixel-size">
              <Inspector workspace={workspace} selection={selection} session={session} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </SidebarProvider>
    </main>
  );
}
