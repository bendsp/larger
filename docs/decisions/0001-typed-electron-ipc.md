# ADR 0001: Typed Electron IPC

Status: accepted

## Decision

The desktop renderer uses typed Electron IPC and main-process event streams for project, runtime, editor, change, and application operations.

The preload exposes narrow namespaced methods and subscriptions. Electron main validates senders, payloads, project generations, trust, and path scope. Domain services remain instantiable without the renderer.

Project, workspace, change, runtime, and editor services are main-owned from the sprint that introduces them. Sprint 04 completes the graph, deletes the legacy HTTP process, and adds packaging; it does not relocate services built in Sprints 01–03.

Electron Forge 7 is the maintained packaging tool. Development artifacts use an ASAR allowlist and reconstruct the lockfile-defined production dependency closure before verification and smoke testing.

## Why

The current HTTP API exists to support Vite development. Keeping it would preserve fixed-port, CORS, token, polling, and lifecycle complexity solely for an in-process desktop client. IPC provides the smaller production trust boundary and native event delivery.

## Consequences

- The legacy Vite `/api` proxy and fixed API port are removed from the desktop architecture.
- Existing HTTP security checks must move to equivalent or stronger service/IPC checks.
- Agent/MCP and remote-preview access, when implemented, use separate authenticated servers over the same domain services.
- Packaging in Sprint 04 must exercise the same contracts as development.
