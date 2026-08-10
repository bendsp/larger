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
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { SidebarProvider } from "@/components/ui/sidebar";
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
    activeUrl: null,
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

function useCanvasBounds(ref: RefObject<HTMLDivElement | null>, enabled: boolean) {
  useEffect(() => {
    const bridge = window.largerCanvas;
    const element = ref.current;
    if (!bridge || !element || !enabled) {
      if (!enabled) bridge?.hide();
      return;
    }

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
  const [serverAddress, setServerAddress] = useState("http://127.0.0.1:3000");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [apiReady, setApiReady] = useState(false);
  const [sessionConfigReady, setSessionConfigReady] = useState(false);
  const canvasMountRef = useRef<HTMLDivElement>(null);
  const loadedSurfaceRef = useRef<string | null>(null);
  const serverAddressHydratedRef = useRef(false);
  const surfaceUrl = session.surface?.kind === "web-url" ? session.surface.url : null;
  const canvasReady = session.phase === "ready" && Boolean(surfaceUrl);
  const canvasVisible = workspace === "canvas" && canvasReady;
  useCanvasBounds(canvasMountRef, canvasVisible);

  useEffect(() => {
    let cancelled = false;
    let retry = 0;
    const loadProject = async () => {
      try {
        const projectValue = await fetchJson<ProjectSummary>("/api/project");
        if (!cancelled) {
          setProject(projectValue);
          setRoute(projectValue.entryRoute);
          setRouteDraft(projectValue.entryRoute);
          setApiReady(true);
          setRequestError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setRequestError(error instanceof Error ? error.message : String(error));
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
        }
      } catch (error) {
        if (!cancelled) setRequestError(error instanceof Error ? error.message : String(error));
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
    const url = new URL(route, `${surfaceUrl}/`).toString();
    const request = loadedSurfaceRef.current === surfaceUrl
      ? window.largerCanvas.navigate(url)
      : window.largerCanvas.load(url);
    loadedSurfaceRef.current = surfaceUrl;
    void request.catch((error: Error) => setRequestError(error.message));
  }, [canvasReady, route, surfaceUrl, workspace]);

  const start = useCallback(async () => {
    setRequestError(null);
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
      setRequestError(error instanceof Error ? error.message : String(error));
    }
  }, [serverAddress, sessionConfigReady]);

  const stop = useCallback(async () => {
    window.largerCanvas?.hide();
    loadedSurfaceRef.current = null;
    setSession((current) => ({ ...current, phase: "stopping" }));
    try {
      const health = await fetchJson<{ capability: string }>("/api/health");
      setSession(await fetchJson<SessionSnapshot>("/api/session/stop", {
        method: "POST",
        headers: { "X-Larger-Capability": health.capability },
      }));
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const changeWorkspace = useCallback((next: Workspace) => {
    setWorkspace(next);
    setSelection(next === "servers" ? { kind: "server" } : null);
  }, []);

  const navigateToRoute = useCallback((nextRoute: string) => {
    const normalized = nextRoute.startsWith("/") ? nextRoute : `/${nextRoute}`;
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
          const url = new URL(route, `${surfaceUrl}/`).toString();
          void window.largerCanvas.navigate(url).catch((error: Error) => setRequestError(error.message));
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
      <header className="app-drag flex min-h-12 items-center border-b bg-background px-4 pl-20">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-tight">Larger</span>
          <span className="text-xs text-muted-foreground">/</span>
          <span className="max-w-64 truncate text-xs text-muted-foreground">{project?.name ?? "reading project"}</span>
        </div>
        <div className="ml-auto flex items-center gap-2 app-no-drag">
          {project && (
            <Badge variant="outline" className="max-w-48 gap-1.5 font-mono text-[10px]">
              <GitBranchIcon className="size-3" />{project.git.branch}
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

      <SidebarProvider
        className="min-h-0 flex-1"
        style={{ "--sidebar-width": "100%" } as CSSProperties}
      >
        <ResizablePanelGroup orientation="horizontal" className="min-h-0">
          <ResizablePanel defaultSize="18%" minSize="15%" maxSize="27%">
            <StudioNavigation project={project} phase={session.phase} workspace={workspace} onWorkspaceChange={changeWorkspace} />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="61%" minSize="42%">
            <section className="h-full min-h-0 bg-background">{renderWorkspace()}</section>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="21%" minSize="17%" maxSize="30%">
            <Inspector workspace={workspace} selection={selection} session={session} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarProvider>

      {(requestError || session.error) && (
        <div className="fixed right-4 bottom-4 z-50 w-[min(420px,calc(100vw-2rem))]">
          <Alert variant="destructive" className="bg-background shadow-xl">
            <AlertTitle>Session error</AlertTitle>
            <AlertDescription>{requestError ?? session.error}</AlertDescription>
            <AlertAction><Button size="xs" variant="ghost" onClick={() => setRequestError(null)}>Dismiss</Button></AlertAction>
          </Alert>
        </div>
      )}
    </main>
  );
}
