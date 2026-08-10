import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  BrandToken,
  ProjectAsset,
  ProjectSummary,
  SessionPhase,
  SessionSnapshot,
} from "./contracts";

type Panel = "routes" | "components" | "assets" | "brand";
type Viewport = "desktop" | "tablet" | "mobile";

const INITIAL_SESSION: SessionSnapshot = {
  phase: "idle",
  targetUrl: null,
  proxyUrl: null,
  websocketUrl: null,
  sourceRoot: "",
  runtimeRoot: null,
  isolation: "sandbox",
  engine: "react-rewrite",
  engineVersion: "0.1.1",
  startedAt: null,
  error: null,
  logs: [],
  changes: [],
};

const PANELS: Array<{ id: Panel; label: string; glyph: GlyphName }> = [
  { id: "routes", label: "Routes", glyph: "route" },
  { id: "components", label: "Components", glyph: "component" },
  { id: "assets", label: "Assets", glyph: "image" },
  { id: "brand", label: "Brand", glyph: "palette" },
];

const VIEWPORTS: Record<Viewport, { label: string; width: number | null; glyph: GlyphName }> = {
  desktop: { label: "Desktop", width: null, glyph: "desktop" },
  tablet: { label: "Tablet", width: 820, glyph: "tablet" },
  mobile: { label: "Mobile", width: 390, glyph: "mobile" },
};

type GlyphName =
  | "arrow"
  | "branch"
  | "component"
  | "desktop"
  | "external"
  | "file"
  | "image"
  | "mobile"
  | "palette"
  | "play"
  | "refresh"
  | "route"
  | "shield"
  | "stop"
  | "tablet";

const GLYPHS: Record<GlyphName, ReactNode> = {
  arrow: <path d="m9 18 6-6-6-6" />,
  branch: <path d="M6 3v12a3 3 0 0 0 3 3h3m0 0-3-3m3 3-3 3M18 3v3a3 3 0 0 1-3 3H9m9-6-2 2m2-2 2 2" />,
  component: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
  desktop: <><rect x="3" y="4" width="18" height="13" rx="1.5" /><path d="M8 21h8m-4-4v4" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m4 17 5-5 4 4 2-2 5 5" /></>,
  mobile: <><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M10 5h4m-3 14h2" /></>,
  palette: <><path d="M12 3a9 9 0 0 0 0 18h1.5a1.8 1.8 0 0 0 0-3.6h-1a1.6 1.6 0 0 1 0-3.2H15A6 6 0 0 0 21 8.5C21 5.5 17 3 12 3Z" /><circle cx="7.5" cy="10" r=".75" fill="currentColor" stroke="none" /><circle cx="10" cy="6.8" r=".75" fill="currentColor" stroke="none" /><circle cx="14" cy="6.5" r=".75" fill="currentColor" stroke="none" /></>,
  play: <path d="m8 5 11 7-11 7Z" />,
  refresh: <><path d="M20 7v5h-5" /><path d="M18.5 16A8 8 0 1 1 20 12" /></>,
  route: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v5a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v-1" /></>,
  shield: <><path d="M12 3 5 6v5c0 4.6 2.6 8 7 10 4.4-2 7-5.4 7-10V6Z" /><path d="m9 12 2 2 4-5" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  tablet: <><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M9 5h6m-4 14h2" /></>,
};

function Glyph({ name, size = 16 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {GLYPHS[name]}
    </svg>
  );
}

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function phaseLabel(phase: SessionPhase): string {
  const labels: Record<SessionPhase, string> = {
    idle: "Not running",
    preparing: "Copying sandbox",
    "starting-target": "Starting project",
    "starting-engine": "Starting canvas",
    ready: "Canvas live",
    stopping: "Stopping",
    error: "Needs attention",
  };
  return labels[phase];
}

function ProjectPanel({ panel, project, onRoute }: { panel: Panel; project: ProjectSummary; onRoute: (route: string) => void }) {
  if (panel === "routes") {
    return (
      <div className="panel-list">
        <PanelIntro eyebrow="Application" title="Routes" meta={`${project.routes.length} discovered`} />
        {project.routes.map((route) => (
          <button
            className="route-row"
            disabled={route.kind === "dynamic"}
            key={route.file}
            onClick={() => onRoute(route.path)}
            title={route.kind === "dynamic" ? "Dynamic routes need fixture data" : `Open ${route.path}`}
          >
            <span className="route-path">{route.path}</span>
            <span className="route-file">{route.file}</span>
            <Glyph name="arrow" size={13} />
          </button>
        ))}
      </div>
    );
  }

  if (panel === "components") {
    const uiCount = project.components.filter((component) => component.family === "ui").length;
    return (
      <div className="panel-list">
        <PanelIntro eyebrow="Source inventory" title="Components" meta={`${project.components.length} found · ${uiCount} UI`} />
        {project.components.map((component) => (
          <div className="component-row" key={component.file}>
            <span className={`component-mark component-mark--${component.family}`} />
            <span>
              <strong>{component.name}</strong>
              <small>{component.file}</small>
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (panel === "assets") {
    const previewAssets = project.assets.filter((asset) => asset.previewUrl);
    return (
      <div className="panel-list panel-list--assets">
        <PanelIntro eyebrow="On disk" title="Assets" meta={`${project.assets.length} indexed`} />
        <div className="asset-grid">
          {previewAssets.map((asset) => <AssetTile asset={asset} key={asset.path} />)}
        </div>
        <div className="asset-file-list">
          {project.assets.filter((asset) => !asset.previewUrl).map((asset) => (
            <div className="asset-file" key={asset.path}>
              <Glyph name="file" size={14} />
              <span><strong>{asset.name}</strong><small>{formatBytes(asset.bytes)}</small></span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const lightTokens = project.brand.tokens.filter((token) => token.mode === "light");
  const darkTokens = project.brand.tokens.filter((token) => token.mode === "dark");
  return (
    <div className="panel-list panel-list--brand">
      <PanelIntro eyebrow="Derived from source" title="Brand kit" meta={`${project.brand.tokens.length} tokens`} />
      <BrandMeta project={project} />
      <TokenGroup label="Light" tokens={lightTokens} />
      <TokenGroup label="Dark" tokens={darkTokens} />
      <section className="brand-section">
        <header><span>Typography</span><small>{project.brand.fonts.length}</small></header>
        {project.brand.fonts.map((font) => (
          <div className="font-card" key={font.family}>
            <span className="font-sample">Ag</span>
            <span>
              <strong>{font.family}</strong>
              <small>{font.weights?.length > 0 ? `${font.weights.join(" / ")} · ${font.source}` : font.source}</small>
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}

function PanelIntro({ eyebrow, title, meta }: { eyebrow: string; title: string; meta: string }) {
  return (
    <header className="panel-intro">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
      <small>{meta}</small>
    </header>
  );
}

function AssetTile({ asset }: { asset: ProjectAsset }) {
  return (
    <figure className="asset-tile" title={asset.path}>
      <div className="asset-preview">
        <img src={asset.previewUrl ?? ""} alt="" loading="lazy" />
      </div>
      <figcaption><span>{asset.name}</span><small>{formatBytes(asset.bytes)}</small></figcaption>
    </figure>
  );
}

function BrandMeta({ project }: { project: ProjectSummary }) {
  const { shadcn } = project.brand;
  return (
    <div className="brand-meta">
      <div><span>Tailwind</span><strong>{project.brand.tailwindConfig ? "Configured" : "Not found"}</strong></div>
      <div><span>shadcn</span><strong>{shadcn.detected ? `${shadcn.style ?? "Detected"} / ${shadcn.iconLibrary ?? "icons"}` : "Not found"}</strong></div>
    </div>
  );
}

function TokenGroup({ label, tokens }: { label: string; tokens: BrandToken[] }) {
  if (tokens.length === 0) return null;
  return (
    <section className="brand-section">
      <header><span>{label}</span><small>{tokens.length}</small></header>
      <div className="token-list">
        {tokens.map((token) => (
          <div className="token-row" key={`${token.mode}-${token.name}-${token.value}`}>
            <span className="token-swatch" style={{ background: token.value }} />
            <span><strong>{token.name.replace(/^--/, "")}</strong><small>{token.value}</small></span>
          </div>
        ))}
      </div>
    </section>
  );
}

function EmptyStudio({ project, onStart }: { project: ProjectSummary | null; onStart: () => void }) {
  return (
    <div className="empty-studio">
      <div className="empty-studio__index">00 / ATTACH</div>
      <div className="empty-studio__mark"><span>L</span></div>
      <p className="empty-studio__kicker">Code is the design document.</p>
      <h2>Design branches,<br />not mockups.</h2>
      <p className="empty-studio__copy">
        {project
          ? `Launch an isolated copy of ${project.name}, then inspect and reshape the real running interface.`
          : "Reading the project directly from disk…"}
      </p>
      <button className="primary-action primary-action--large" disabled={!project} onClick={onStart}>
        <Glyph name="play" size={15} />
        Launch sandbox canvas
      </button>
      <div className="empty-studio__proofs">
        <span><b>01</b> real dev server</span>
        <span><b>02</b> source-aware overlay</span>
        <span><b>03</b> disposable writes</span>
      </div>
    </div>
  );
}

export function App() {
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [session, setSession] = useState<SessionSnapshot>(INITIAL_SESSION);
  const [panel, setPanel] = useState<Panel>("routes");
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [route, setRoute] = useState("/");
  const [routeDraft, setRouteDraft] = useState("/");
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [apiReady, setApiReady] = useState(false);
  const capabilityRef = useRef<string | null>(null);
  const canvasMountRef = useRef<HTMLDivElement>(null);
  const loadedProxyRef = useRef<string | null>(null);
  const canvasReady = session.phase === "ready" && Boolean(session.proxyUrl);
  useCanvasBounds(canvasMountRef, canvasReady);

  useEffect(() => {
    let cancelled = false;
    let retry = 0;
    const loadProject = async () => {
      try {
        const [projectValue, health] = await Promise.all([
          fetchJson<ProjectSummary>("/api/project"),
          fetchJson<{ capability: string }>("/api/health"),
        ]);
        if (!cancelled) {
          capabilityRef.current = health.capability;
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
        if (!cancelled) setSession(snapshot);
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
    if (!canvasReady || !session.proxyUrl || !window.largerCanvas) {
      if (!canvasReady) {
        loadedProxyRef.current = null;
        window.largerCanvas?.hide();
      }
      return;
    }
    if (loadedProxyRef.current === session.proxyUrl) return;
    loadedProxyRef.current = session.proxyUrl;
    const url = new URL(route, `${session.proxyUrl}/`).toString();
    void window.largerCanvas.load(url).catch((error: Error) => setRequestError(error.message));
  }, [canvasReady, route, session.proxyUrl]);

  useEffect(() => window.largerCanvas?.onNavigation(setCurrentUrl), []);

  const start = useCallback(async () => {
    setIsStarting(true);
    setRequestError(null);
    setSession((current) => ({ ...current, phase: "preparing", error: null }));
    try {
      const health = await fetchJson<{ capability: string }>("/api/health");
      capabilityRef.current = health.capability;
      setSession(await fetchJson<SessionSnapshot>("/api/session/start", {
        method: "POST",
        headers: { "X-Larger-Capability": health.capability },
      }));
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsStarting(false);
    }
  }, []);

  const stop = useCallback(async () => {
    window.largerCanvas?.hide();
    loadedProxyRef.current = null;
    setSession((current) => ({ ...current, phase: "stopping" }));
    try {
      const health = await fetchJson<{ capability: string }>("/api/health");
      capabilityRef.current = health.capability;
      setSession(await fetchJson<SessionSnapshot>("/api/session/stop", {
        method: "POST",
        headers: { "X-Larger-Capability": health.capability },
      }));
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const navigateToRoute = useCallback((nextRoute: string) => {
    setRoute(nextRoute);
    setRouteDraft(nextRoute);
    if (!session.proxyUrl || !window.largerCanvas) return;
    const url = new URL(nextRoute, `${session.proxyUrl}/`).toString();
    void window.largerCanvas.navigate(url).catch((error: Error) => setRequestError(error.message));
  }, [session.proxyUrl]);

  const submitRoute = (event: FormEvent) => {
    event.preventDefault();
    navigateToRoute(routeDraft.startsWith("/") ? routeDraft : `/${routeDraft}`);
  };

  const viewportStyle = useMemo(() => {
    const width = VIEWPORTS[viewport].width;
    return width ? { width: `${width}px`, maxWidth: "100%" } : undefined;
  }, [viewport]);

  const visibleLogs = session.logs.slice(-7).reverse();
  const isBusy = ["preparing", "starting-target", "starting-engine", "stopping"].includes(session.phase);
  const nativeAvailable = Boolean(window.largerCanvas);

  return (
    <main className="studio-shell">
      <header className="titlebar">
        <div className="wordmark">
          <span className="wordmark__symbol">L</span>
          <span className="wordmark__name">Larger</span>
          <span className="wordmark__thesis">design branches, not mockups</span>
        </div>
        <div className="project-pill">
          <Glyph name="branch" size={14} />
          <span>{project?.name ?? "reading project"}</span>
          <small>{project?.git.branch ?? "—"}</small>
        </div>
        <div className="titlebar__actions">
          <div className={`live-status live-status--${session.phase}`}>
            <span className="live-status__dot" />
            {phaseLabel(session.phase)}
          </div>
          {session.phase === "ready" ? (
            <button className="ghost-action" onClick={stop}><Glyph name="stop" size={14} /> Stop</button>
          ) : (
            <button className="primary-action" disabled={!project || !apiReady || isBusy || isStarting} onClick={start}>
              <Glyph name="play" size={14} /> Launch canvas
            </button>
          )}
        </div>
      </header>

      <div className="studio-body">
        <nav className="tool-rail" aria-label="Project views">
          <div className="tool-rail__group">
            {PANELS.map((item) => (
              <button
                aria-label={item.label}
                className={panel === item.id ? "active" : ""}
                key={item.id}
                onClick={() => setPanel(item.id)}
                title={item.label}
              >
                <Glyph name={item.glyph} size={17} />
              </button>
            ))}
          </div>
          <div className="tool-rail__footer"><span>v0.0.1</span></div>
        </nav>

        <aside className="project-sidebar">
          {project ? (
            <ProjectPanel panel={panel} project={project} onRoute={navigateToRoute} />
          ) : (
            <div className="sidebar-loading"><span /><span /><span /><span /></div>
          )}
        </aside>

        <section className="canvas-column">
          <div className="canvas-toolbar">
            <form className="route-control" onSubmit={submitRoute}>
              <span className="route-control__origin">{session.proxyUrl ? new URL(session.proxyUrl).host : "local canvas"}</span>
              <span className="route-control__slash">/</span>
              <input
                aria-label="Canvas route"
                disabled={!canvasReady}
                onChange={(event) => setRouteDraft(event.target.value)}
                spellCheck={false}
                value={routeDraft.replace(/^\//, "")}
              />
            </form>
            <div className="viewport-switcher" aria-label="Viewport size">
              {(Object.keys(VIEWPORTS) as Viewport[]).map((key) => (
                <button
                  aria-label={VIEWPORTS[key].label}
                  className={viewport === key ? "active" : ""}
                  key={key}
                  onClick={() => setViewport(key)}
                  title={VIEWPORTS[key].label}
                >
                  <Glyph name={VIEWPORTS[key].glyph} size={15} />
                </button>
              ))}
            </div>
            <div className="canvas-toolbar__meta">
              <span>{viewport === "desktop" ? "FIT" : `${VIEWPORTS[viewport].width}px`}</span>
              <button
                aria-label="Reload canvas"
                disabled={!currentUrl || !window.largerCanvas}
                onClick={() => currentUrl && window.largerCanvas?.navigate(currentUrl)}
                title="Reload canvas"
              ><Glyph name="refresh" size={14} /></button>
            </div>
          </div>

          <div className={`canvas-stage canvas-stage--${viewport}`}>
            <div className="canvas-ruler canvas-ruler--top" />
            <div className="canvas-ruler canvas-ruler--left" />
            <div className="canvas-frame" style={viewportStyle}>
              <div className="canvas-frame__bar">
                <span /><span /><span />
                <em>{project?.name ?? "project"} · {route}</em>
                <b>{canvasReady ? "LIVE" : "OFFLINE"}</b>
              </div>
              <div className="native-canvas-slot" ref={canvasMountRef}>
                {!canvasReady && <EmptyStudio project={project} onStart={start} />}
                {canvasReady && !nativeAvailable && (
                  <div className="native-required">
                    <strong>Open this studio through Electron.</strong>
                    <span>React Rewrite disables its overlay in ordinary iframes, so the POC intentionally has no fake browser fallback.</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        <aside className="context-sidebar">
          <section className="context-header">
            <span>Run context</span>
            <h2>Live source</h2>
          </section>

          <section className="safety-card">
            <div className="safety-card__icon"><Glyph name="shield" size={18} /></div>
            <div><strong>Isolated working copy</strong><span>The editing engine is rooted in a disposable copy. The configured dev command remains trusted local code.</span></div>
          </section>

          <section className="context-section">
            <header><span>Connection</span><small>{phaseLabel(session.phase)}</small></header>
            <dl className="fact-list">
              <div><dt>Engine</dt><dd>React Rewrite {session.engineVersion}</dd></div>
              <div><dt>Target</dt><dd>{project?.framework ?? "—"} / {project?.packageManager ?? "—"}</dd></div>
              <div><dt>Surface</dt><dd>Native WebContentsView</dd></div>
              <div><dt>Engine writes</dt><dd>Working copy</dd></div>
            </dl>
          </section>

          {project && project.git.dirtyFiles.length > 0 && (
            <section className="wip-card">
              <header><span>Existing local work</span><b>{project.git.dirtyFiles.length}</b></header>
              <p>Preserved in the source checkout and copied into the sandbox baseline.</p>
              <ul>{project.git.dirtyFiles.map((file) => <li key={file}>{file}</li>)}</ul>
            </section>
          )}

          <section className="context-section context-section--changes">
            <header><span>Sandbox changes</span><small>{session.changes.length}</small></header>
            {session.changes.length === 0 ? (
              <div className="empty-changes"><span>∅</span><p>No source operations yet.</p></div>
            ) : (
              <ul className="change-list">
                {session.changes.map((change) => (
                  <li key={change.file}><b>{change.status[0].toUpperCase()}</b><span>{change.file}</span></li>
                ))}
              </ul>
            )}
          </section>

          <section className="context-section context-section--logs">
            <header><span>Process tape</span><small>{session.logs.length}</small></header>
            <div className="log-list">
              {visibleLogs.length === 0 ? <p>Waiting for a launch.</p> : visibleLogs.map((log, index) => (
                <div className={`log-row log-row--${log.source}`} key={`${log.at}-${index}`}>
                  <span>{log.source.slice(0, 1)}</span><p>{log.message}</p>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>

      {(requestError || session.error) && (
        <div className="error-toast" role="alert">
          <strong>Canvas could not continue</strong>
          <span>{requestError ?? session.error}</span>
          <button onClick={() => setRequestError(null)}>Dismiss</button>
        </div>
      )}
    </main>
  );
}
