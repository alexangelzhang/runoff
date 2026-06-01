# Dev Container (optional)

Reproducible environment for **developing runoff itself** (not for shipping a production image).

## Open in Codespaces / VS Code

1. Open repo → **Reopen in Container** (`.devcontainer/devcontainer.json`).
2. Wait for `postCreateCommand` (`npm install && npm run demo`).
3. Scaffold a consumer config: `npm run runoff:init -- --work-dir /workspaces/runoff/tmp/sample-repo --profile feature`

Includes **Node 22**, **Python 3.12**, **Git**. Coding-agent CLIs (Codex, Gemini, …) are **not** pre-installed — install on the host or inside the container as needed.

## Edit config UI from container

Forward port manually when running:

```bash
npm run runoff:config:edit -- --config examples/configs/feature.config.json --no-open
```

Use the printed `http://127.0.0.1:PORT` URL (port forwarding in VS Code / Codespaces).

See [getting-started-30min.md](guides/getting-started-30min.md).
