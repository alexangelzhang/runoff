# experimental/

This directory contains features under active development that are **not covered by semver guarantees**.

Anything inside `experimental/` may change, be renamed, or be removed in any release without a major version bump.

## a2a/

Agent-to-Agent federation — multi-node sync, lease management, CRDT-based conflict resolution, and HTTP transport.

**Do not import these modules directly** in application code that expects stability. The public API surface is exposed via `src/index.ts`; paths under `experimental/` are internal implementation details.

When a feature graduates to stable, it will be moved out of `experimental/` and announced in `CHANGELOG.md`.
