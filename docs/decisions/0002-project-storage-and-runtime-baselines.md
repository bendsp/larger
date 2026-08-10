# ADR 0002: Project storage and runtime baselines

Status: accepted

## Decision

Shareable configuration lives at `<project>/.larger/project.json`. Its ID identifies the logical project. Machine-local and disposable state lives beneath Electron `app.getPath("userData")`, keyed by a local instance key derived from the logical ID and canonical checkout path.

Every runtime workspace has an immutable baseline and writable materialization under application data. Baseline and edited content required for recovery outlive the disposable runtime. ChangeSets are filesystem-derived and their semantics do not depend on the materialization provider.

## Why

Putting caches or runtimes beside canonical project files makes Git state ambiguous and can recursively copy Larger state into itself. Tying diffs to one sandbox implementation would also make a later performance change rewrite conflict and recovery behavior.

## Consequences

- The manifest contains no absolute paths or secrets.
- Clones and worktrees share a logical project ID but never local trust, writable caches, runtimes, or recovery data.
- Recents, trust, UI state, logs, caches, recovery data, and runtimes are personal application data keyed by local instance.
- Materialization may use copy-on-write clones with a portable fallback.
- Git worktrees are not the universal provider because Git is optional and dirty/untracked working-tree state must be represented.
- Editor notifications may enrich a ChangeSet but never replace the filesystem baseline.
- Dependency cache entries are immutable and keyed by package manager, lockfile, runtime, platform, architecture, and relevant toolchain version; canonical dependencies are never exposed as shared writable runtime state.
- Multi-file apply uses a durable transaction journal and per-file atomic replacements. Partial application is an explicit recoverable state, not described as cross-file atomicity.
- Every source replacement revalidates canonical containment, destination parents, symlink state, and local-instance authorization immediately before writing.
