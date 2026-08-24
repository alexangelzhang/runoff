# Testing layout

Run the full suite:

```bash
npm test          # tests/**/*.test.ts
npm run test:ci   # concurrency=1 (CI parity)
```

## Directories

| Directory | Purpose | Examples |
|-----------|---------|----------|
| `tests/unit/` | Fast unit tests (default bulk) | `config.test.ts`, `pipeline-runner.test.ts` |
| `tests/e2e/` | Gate + git worktree smoke | `gate2-control-plane.e2e.test.ts`, `orchestration.smoke.test.ts` |
| `tests/integration/` | Opt-in real providers, phase8 | `real-provider.integration.test.ts` (registered only with `RUNOFF_RUN_REAL_PROVIDER_SMOKE=1`), `memory-sdk.integration.test.ts` (registered only when the optional SDK is installed) |
| `tests/federation/` | A2A / federation leases | `federation-sync.test.ts`, `a2a-http-transport.test.ts` |
| `tests/helpers/` | Shared test utilities | `repo-root.ts` (`REPO_ROOT`) |

## Focused scripts

| Command | Target |
|---------|--------|
| `npm run test:gate2` | `tests/e2e/gate2-control-plane.e2e.test.ts` |
| `npm run test:gate3` | `tests/e2e/gate3-orchestrator.e2e.test.ts` |
| `npm run test:real-providers` | `tests/integration/real-provider.integration.test.ts` |
| `npm run test:sdk-memory` | `tests/integration/memory-sdk.integration.test.ts` |
| `npm run clean:test-traces` | Remove `tests/.tmp-traces-*` ephemeral dirs |

## Imports from tests

Use repo-relative paths from the test subfolder, e.g. `../../src/core/config.ts` from `tests/unit/`.

For repo root in e2e scripts: `import { REPO_ROOT } from "../helpers/repo-root.js"`.
