# Architecture

React Rewrite is isolated behind a canvas engine interface.

```ts
interface CanvasEngine {
  readonly id: string;
  readonly version: string;
  start(input: {
    projectRoot: string;
    host: string;
    port: number;
  }): Promise<{
    proxyUrl: string;
    websocketUrl: string | null;
  }>;
  stop(): Promise<void>;
}
```

The adapter launches the installed React Rewrite binary from the disposable working copy and parses its proxy URLs. The renderer only consumes the session contract.

```text
Electron main
  ├── studio BrowserWindow
  └── canvas WebContentsView

Local API
  ├── manifest reader
  ├── project inspector
  ├── sandbox copier / change detector
  └── session manager
        ├── target dev-server process
        └── CanvasEngine process

React renderer
  ├── project views
  ├── viewport controls
  └── session state
```

The native canvas view is required because React Rewrite does not run its overlay inside an iframe.

## Trust boundary

The working copy protects the source checkout from engine writes; it is not an operating-system sandbox. The configured development command is trusted local code, and the upstream React Rewrite proxy and WebSocket listeners are unauthenticated. Run sessions only on a trusted machine and network, then stop them after use.
