# POC architecture

## Product boundary

React Rewrite solves the difficult React-to-source path. Larger owns the surrounding workflow: project intelligence, working-copy isolation, canvas hosting, assets, brand context, Git variants, and future agent operations.

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

The first adapter resolves Larger's pinned React Rewrite binary, launches it with the sandbox as `cwd`, and parses the dynamically allocated proxy and WebSocket URLs. No UI component imports React Rewrite internals.

## Runtime ownership

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
  ├── routes / components
  ├── assets / brand
  ├── viewport geometry
  └── run context / change tape
```

The native view is required because React Rewrite exits early when its document is inside an iframe. It also creates a hard but useful layout constraint: studio controls reserve space around the canvas instead of layering arbitrary DOM over it.

## Next seam to extract

The upstream overlay currently owns selection and editing. The next meaningful experiment is a headless runtime bridge with events such as:

```ts
engine.on("selection", (node) => {});
engine.preview(operation);
engine.commit(operation);
engine.revert(patchId);
```

That bridge should preserve the current `CanvasEngine` boundary while moving selection chrome and patch review into Larger. It should also add loopback-only binding, a per-session token, multi-client semantics, and a patch preview that does not write until the user confirms in the host app.

## Deliberately absent

- No database for project truth.
- No independent scene graph.
- No code export.
- No realtime multiplayer.
- No agent provider or credit system.
- No universal “drag any pixel” promise.

The next product feature should be Git-backed design variants only after safe patch staging and the outer selection bridge are proven.
