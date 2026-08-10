# Architecture

Larger owns projects, working copies, sessions, and interface state. Editor integrations sit behind a registered adapter boundary.

```ts
interface EditorAdapter {
  readonly descriptor: EditorAdapterDescriptor;
  start(input: {
    workspaceRoot: string;
    target: { url: string };
  }): Promise<EditorSurface>;
  stop(): Promise<void>;
}
```

The descriptor normalizes compatibility, client limits, and who controls each capability: the Larger studio, the embedded editor UI, or nobody. A session exposes an abstract surface instead of React Rewrite proxy details.

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
        └── EditorAdapter
              └── React Rewrite process

React renderer
  ├── project views
  ├── viewport controls
  └── session state
```

## Dependency direction

`SessionManager` depends only on `EditorAdapter`. The adapter registry selects an implementation from the manifest. React Rewrite package discovery, arguments, stdout parsing, endpoint readiness, process quirks, and capability declarations live together in `server/adapters/react-rewrite.ts`.

The renderer consumes only `SessionSnapshot.adapter` and `SessionSnapshot.surface`; it never sees React Rewrite proxy or WebSocket fields. Updating React Rewrite should therefore be an adapter-and-contract-test change. Supporting another web or native editor adds an adapter and, only when necessary, a new surface renderer.

The current React Rewrite adapter reports editing as `embedded` because the upstream overlay owns selection and edits. A future headless adapter can report those same capabilities as `studio` without changing project or session data.

## Trust boundary

The working copy protects the source checkout from engine writes; it is not an operating-system sandbox. The configured development command is trusted local code, and the upstream React Rewrite proxy and WebSocket listeners are unauthenticated. Run sessions only on a trusted machine and network, then stop them after use.
