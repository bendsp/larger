# Architecture

Larger is a Git-native desktop design environment for real codebases. The source repository remains authoritative. Runtimes are disposable, reviewable working copies; integrations are replaceable engines behind owned contracts.

This document records the target architecture for Sprints 01–05. The `mvp` branch is being migrated toward it incrementally, so code that still uses the local HTTP API or studio-root manifest is legacy, not a competing design.

## Ownership

```text
Electron main
  ├── ProjectManager
  │     ├── project manifest and detection
  │     ├── recents and trust
  │     └── project-scoped service generation
  ├── ChangeService
  │     ├── immutable runtime baseline
  │     ├── filesystem-derived ChangeSets
  │     └── selective, conflict-aware source application
  ├── RuntimeService
  │     ├── runtime workspace provider
  │     ├── managed and attached runtime adapters
  │     └── owned process lifecycle
  ├── EditorService
  │     └── EditorAdapter
  │           └── React Rewrite adapter
  ├── studio BrowserWindow
  └── sandboxed canvas WebContentsView

Preload bridge
  └── narrow typed operations and event subscriptions

React renderer
  ├── project and runtime navigation
  ├── canvas controls
  ├── change review
  └── normalized inspector state
```

Electron main owns filesystem authority, trust, child processes, application-data paths, services, and canvas lifecycle. Every new domain service is main-owned from its first implementation; Sprint 04 removes the remaining legacy transport rather than relocating services. The renderer owns presentation and transient interaction state. Target pages never receive the studio preload bridge.

## Project and application data

Project-owned configuration lives at `<project>/.larger/project.json`. It contains a schema version, stable project identity, relative paths, and shareable runtime/editor configuration. It never contains machine-specific absolute paths or secrets.

The versioned project ID identifies one logical project. A separate local instance key combines that ID with the canonical checkout path, preventing clones and worktrees from sharing trust, runtimes, recovery records, or writable caches.

Personal and disposable data lives beneath Electron `app.getPath("userData")`, keyed by local instance:

- recents and trust decisions;
- personal UI state and secret values;
- indexes, logs, and caches;
- runtime workspaces, baselines, recovery records, and unapplied ChangeSets.

No runtime or cache lives in the Larger checkout or canonical project tree.

## Desktop service boundary

The production renderer boundary is typed Electron IPC with main-process event streams. The preload exposes named domain operations, not raw `ipcRenderer`, Node, filesystem, shell, or process primitives.

Remote previews and agent/MCP access are separate opt-in, authenticated services that adapt the same domain services. They do not justify retaining a local HTTP API as the desktop renderer boundary.

See [ADR 0001](./decisions/0001-typed-electron-ipc.md).

## Runtime and change invariants

A runtime workspace has:

- a stable project and session identity;
- an immutable baseline representing the source state it began from;
- a writable materialized workspace under application data;
- explicit ownership and lifecycle metadata.

ChangeSets are derived from filesystem baselines. Recoverable ChangeSets persist baseline and edited content or patch blobs outside the runtime. Editor events may improve latency or context, but they never become the sole record of a source change. Applying work uses selected hunks plus baseline data; it never blindly copies runtime files over source files.

Multi-file source application is journaled, not falsely described as atomic. Each file uses compare-and-swap revalidation and atomic replacement. A versioned transaction journal stores hashes, selected results, backups, phase markers, and durable ordering so an interrupted partial apply can be detected and safely rolled forward, rolled back, or surfaced as a conflict.

Source application resolves the authorized project instance canonically and revalidates every destination parent immediately before replacement. Symlink traversal, parent replacement races, stale instance authorization, and destinations outside the canonical source root are rejected.

Materialization may use copy-on-write clones or a portable copy fallback, but the provider cannot alter baseline, diff, drift, conflict, or recovery semantics. Git is optional and Git worktrees are not the universal runtime strategy because they do not represent dirty and untracked working-tree state by themselves.

Dependency caches are immutable inputs, never shared writable `node_modules`. Their identity includes package manager, lockfile digest, platform, architecture, runtime, and relevant toolchain version; each runtime receives a writable clone or materialization.

See [ADR 0002](./decisions/0002-project-storage-and-runtime-baselines.md).

## Runtime and editor separation

`RuntimeAdapter` owns target launch or attachment, readiness, logs, and owned process cleanup. `EditorAdapter` owns editor compatibility, process lifecycle, surface creation, and normalized editor events. Neither contract exposes implementation-specific endpoints to the renderer.

React Rewrite package discovery, arguments, maintained patches, output parsing, listener verification, and upstream quirks stay inside its adapter. Supporting another editor cannot require rewriting project lifecycle, runtime ownership, ChangeSets, or desktop IPC.

The existing embedded React Rewrite overlay owns its edits and selection. Larger must not claim studio-owned capabilities until a proven bridge delivers them.

## Trust and network boundary

Opening a repository is passive. Git, package managers, framework CLIs, development servers, and editor engines are repository-scoped code execution and require explicit trust.

The runtime workspace protects the source from cooperative engine writes; it is not an operating-system security sandbox. Canonical containment, symlink-escape rejection, project-generation checks, minimal child environments, and owned process cleanup remain mandatory.

No unauthenticated or non-loopback file-writing listener may be considered ready. Before the first managed editor session in Sprint 03, the React Rewrite integration must enforce explicit loopback binding, a per-session capability, Origin validation, canonical runtime containment, and symlink/path revalidation at write time. Any Larger-owned selection bridge must authenticate the active canvas sender and project generation.

Attached servers are preview-only. File-writing editor capabilities require a Larger-owned runtime and the ChangeSet apply path.

Recovered process identifiers are not proof of ownership. Cleanup requires an ownership nonce plus executable, start-time, and process-group verification so PID reuse can never signal an unrelated process.

See [ADR 0003](./decisions/0003-react-rewrite-security-and-selection-gates.md).

## Review rule

Each sprint is complete only after its acceptance criteria, production tests, independent code review, assessed fixes, and a final Claude roast have passed. A fake adapter or mocked happy path can test consumers, but cannot prove production readiness for an integration.
