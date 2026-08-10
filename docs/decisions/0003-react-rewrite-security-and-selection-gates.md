# ADR 0003: React Rewrite security and selection gates

Status: accepted gate; bridge implementation pending

## Decision

React Rewrite remains a pinned adapter dependency, optionally accompanied by a thin mechanically rebaseable patch or companion. A full fork requires a separate reviewed decision.

Before the first managed editor launch in Sprint 03, the adapter must enforce explicit loopback binding, a high-entropy per-session capability, browser Origin validation, canonical runtime containment, and symlink/path revalidation at write time. Failure of any probe blocks readiness.

Larger cannot claim studio-owned selection until a real fixture proves a structured component/file/line event across an authenticated, generation-bound bridge.

## Selection spike order

1. Test a Larger-owned canvas preload/main-world bridge without assuming it can read internal overlay state.
2. Test a thin companion package or maintained package patch.
3. Pursue an upstream SDK/RPC/browser bridge without making delivery depend on an unmerged request.

The spike ends with working evidence or a documented stop decision; architectural preference alone is insufficient.

## Consequences

- Filesystem baselines remain authoritative for changes.
- Attached servers remain preview-only; writable operations require a Larger-owned runtime.
- Adapter endpoints, output formats, patches, and upstream quirks remain adapter-local.
- Stale canvas, sender, origin, and project-generation events are rejected.
- Compatibility claims cover only fixture combinations actually verified.
- A fake adapter may support tests but does not validate a generalized plugin platform.
