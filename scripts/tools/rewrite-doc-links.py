#!/usr/bin/env python3
"""One-shot rewriter after docs/ subdir layout. Safe to re-run (idempotent)."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# flat docs/foo.md -> docs/<category>/foo.md
FLAT = {
    "getting-started-30min.md": "guides/getting-started-30min.md",
    "mcp-host-setup.md": "guides/mcp-host-setup.md",
    "mock-to-real-cli.md": "guides/mock-to-real-cli.md",
    "coding-agent-backends.md": "guides/coding-agent-backends.md",
    "testing.md": "guides/testing.md",
    "ci-branch-protection.md": "operations/ci-branch-protection.md",
    "release-publish-checklist.md": "operations/release-publish-checklist.md",
    "release-workflow-template.md": "operations/release-workflow-template.md",
    "real-provider-smoke.md": "operations/real-provider-smoke.md",
    "real-provider-smoke-runner-checklist.md": "operations/real-provider-smoke-runner-checklist.md",
    "timeouts.md": "operations/timeouts.md",
    "stability-boundaries.md": "operations/stability-boundaries.md",
    "devcontainer.md": "operations/devcontainer.md",
    "observability-collector-local.md": "operations/observability-collector-local.md",
    "structure.md": "architecture/structure.md",
    "execution-layers.md": "architecture/execution-layers.md",
    "trace-lifecycle.md": "architecture/trace-lifecycle.md",
    "governance-config.md": "architecture/governance-config.md",
    "pipeline-hooks-runtime.md": "architecture/pipeline-hooks-runtime.md",
    "security-model.md": "architecture/security-model.md",
    "observability.md": "features/observability.md",
    "observability-eval.md": "features/observability-eval.md",
    "memory-production.md": "features/memory-production.md",
    "memory-dream-roadmap.md": "features/memory-dream-roadmap.md",
    "dream.md": "features/dream.md",
    "dreamify.md": "features/dreamify.md",
    "a2a-federation.md": "features/a2a-federation.md",
    "deerflow-reflect.md": "features/deerflow-reflect.md",
    "external-memory.md": "features/external-memory.md",
    "differentiation.md": "reference/differentiation.md",
    "industry-benchmark.md": "reference/industry-benchmark.md",
    "OPEN_SOURCE.md": "reference/OPEN_SOURCE.md",
    "supported-backends.md": "reference/supported-backends.md",
    "benchmark-pins.json": "reference/benchmark-pins.json",
}

SKIP_DIRS = {"node_modules", "dist", ".git", "tests/.tmp-traces"}


def should_touch(path: Path) -> bool:
    parts = path.parts
    if any(p in SKIP_DIRS for p in parts):
        return False
    if path.suffix not in {".md", ".ts", ".yml", ".yaml", ".sh", ".json"}:
        return False
    return True


def rewrite_text(text: str) -> str:
    for old, new in FLAT.items():
        text = text.replace(f"docs/{old}", f"docs/{new}")
    # Relative links inside docs/ (basename only)
    for old, new in FLAT.items():
        # ](foo.md) or ](../foo.md) — avoid already-qualified paths
        for prefix in ("", "../", "../../"):
            pat = re.compile(
                rf"(\]\({re.escape(prefix)}{re.escape(old)})(\)|#)",
            )
            repl = rf"]({prefix}{new}\2" if prefix else rf"](docs/{new}\2"
            if prefix:
                text = pat.sub(lambda m: f"]({prefix}{new}{m.group(2)}", text)
            else:
                # same-dir: use category path from repo root style when under docs/
                text = pat.sub(lambda m: f"]({new}{m.group(2)}", text)
    return text


def main() -> None:
    changed = 0
    for path in ROOT.rglob("*"):
        if not path.is_file() or not should_touch(path):
            continue
        try:
            raw = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        out = rewrite_text(raw)
        if out != raw:
            path.write_text(out, encoding="utf-8")
            changed += 1
            print(path.relative_to(ROOT))
    print(f"updated {changed} files")


if __name__ == "__main__":
    main()
