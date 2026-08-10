# Larger

**Design branches, not mockups.**

Larger is an early proof of concept for a Git-native visual design IDE. It attaches to a real React codebase, derives useful project context from normal files, launches the real development server, and places a source-aware visual editor around the running app.

The current vertical slice is deliberately narrow:

- Inspect routes, components, assets, CSS variables, local fonts, Tailwind, shadcn, and Git state.
- Copy the target working tree into a disposable sandbox without touching the original checkout.
- Start the target dev server inside that sandbox.
- Spawn the pinned `react-rewrite-cli@0.1.1` as a subprocess.
- Render its proxy in an Electron `WebContentsView`, where React Rewrite's overlay remains active.
- Navigate routes and switch between desktop, tablet, and mobile canvas widths.
- Surface confirmed sandbox edits as changed files in the studio.

The included manifest targets the sibling `/Users/ben/Code/desprets.net` checkout. The verified run on 2026-08-10 did not write to that checkout.

## Run it

Requirements:

- Node.js 20 or newer.
- The target project's dependencies already installed.
- `pnpm` available for the included `desprets.net` manifest.

```bash
npm install
npm run dev
```

The command starts the local project API, Vite renderer, and Electron shell. Click **Launch canvas** to perform the explicit process-start step.

Useful verification commands:

```bash
npm test
npm run build
```

## File over app

The only authored project configuration is [`larger.project.json`](./larger.project.json), described by [`schemas/larger-project.schema.json`](./schemas/larger-project.schema.json) and checked at startup for the fields this POC consumes. Routes, assets, design tokens, component inventory, and Git status are derived from the target checkout on demand. Disposable runtime state lives under `.larger/` and is ignored by Git.

The source code remains authoritative:

```text
target checkout (inspected and copied)
          │
          ├── routes / components / brand / assets
          │
          └── sandbox copy
                  │
                  ├── real dev server
                  │
                  └── React Rewrite proxy
                            │
                            └── native canvas view
```

## Isolation model for trusted local projects

The POC only implements `engine.mode: "sandbox"`.

- `.git`, `.next*`, `out`, and `node_modules` are excluded from the copy.
- The target's existing `node_modules` is copied with copy-on-write cloning where the filesystem supports it, so no install runs in the target and dependency paths do not provide a write-through escape from the sandbox.
- Source-tree symlinks are omitted, and dependency symlinks must resolve inside the copied `node_modules` tree.
- The React Rewrite process runs with the sandbox as its working directory, so its path checks cannot write back to the original checkout.
- There is intentionally no “apply to source” button yet.

This is working-copy isolation, not an operating-system security sandbox. The configured development command is trusted local code, inherits the user's environment, and could access paths outside its working directory. React Rewrite 0.1.1 also publishes an unauthenticated proxy/WebSocket pair on all interfaces; use this POC only on a trusted local machine/network and stop the canvas when it is not being exercised. A production engine fork must bind both services to loopback and add per-session authentication.

The included target currently has four pre-existing unstaged edits. Larger shows them as context, includes them in the sandbox baseline, and leaves them untouched.

## Architecture seam

React Rewrite is treated as an engine, not as Larger's product identity. Its CLI-only lifecycle and stdout parsing are isolated behind `CanvasEngine` in [`server/canvas-engine.ts`](./server/canvas-engine.ts). The renderer only consumes the generic session contract in [`src/contracts.ts`](./src/contracts.ts).

This leaves room for a later headless React adapter without coupling the rest of the product to React Fiber or React Rewrite's UI.

## What the POC proved

Against the `desprets.net` working tree on 2026-08-10, the end-to-end run verified:

- Next.js, pnpm, Tailwind, shadcn, 18 routes, 19 components, 54 assets, Satoshi 400/500/700, and light/dark CSS variables are derived from files.
- Next starts from the sandbox and is served through React Rewrite's injected proxy.
- The live overlay selects a client component and resolves it to `components/theme-toggle.tsx:15`.
- A confirmed text edit hot-reloads the target and appears as exactly one changed sandbox file.
- The original checkout retains exactly its same four pre-existing changes.

## Known boundaries

- React Rewrite disables its overlay in regular iframes, so the working canvas requires Electron's native `WebContentsView`.
- The published engine has no stable parent-app selection bridge; its overlay owns selection and editing for now.
- It accepts one active overlay client at a time.
- Next App Router client components map successfully, but React Server Components and compiled MDX can report unresolved source files. That limitation is visible rather than hidden.
- React Rewrite may normalize JSX formatting when confirming a text edit. Reviewable patch staging belongs in the next engine layer.
- The studio is development-only: packaging, auto-update, agent MCP, design branches, and applying sandbox changes are not part of this proof.

See [`docs/architecture.md`](./docs/architecture.md) for the next extraction boundary.

## Credits

Larger uses [React Rewrite](https://github.com/donghaxkim/react-rewrite) by Dongha Kim as its initial React/source engine. It is installed as an unmodified MIT-licensed dependency. See [`NOTICE.md`](./NOTICE.md).
