#!/usr/bin/env python3
"""Update paths after examples/configs and issues/{open,archive} layout."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKIP = {"node_modules", "dist", ".git"}

REPLACEMENTS = [
    ("examples/quickstart.config.json", "examples/configs/quickstart.config.json"),
    ("examples/feature.config.json", "examples/configs/feature.config.json"),
    ("examples/bugfix.config.json", "examples/configs/bugfix.config.json"),
    ("examples/refactor.config.json", "examples/configs/refactor.config.json"),
    ("examples/cli.config.json", "examples/configs/cli.config.json"),
    ("examples/*.config.json", "examples/configs/*.config.json"),
    ("examples/{feature,bugfix,refactor}.config.json", "examples/configs/{feature,bugfix,refactor}.config.json"),
    ("issues/real-provider-smoke-cli-2026-05.md", "issues/open/real-provider-smoke-cli-2026-05.md"),
    ("issues/P0-TRIAGE-2026-05.md", "issues/archive/P0-TRIAGE-2026-05.md"),
    ("issues/issue5_close.md", "issues/archive/issue5_close.md"),
    ("issues/issue6_close.md", "issues/archive/issue6_close.md"),
    ("issues/issue7_close.md", "issues/archive/issue7_close.md"),
    ("issues/issue8_close.md", "issues/archive/issue8_close.md"),
]


def main() -> None:
    n = 0
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix not in {".md", ".ts", ".sh", ".json", ".yml"}:
            continue
        if any(p in SKIP for p in path.parts):
            continue
        if path.name == "rewrite-examples-issues-links.py":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        out = text
        for old, new in REPLACEMENTS:
            out = out.replace(old, new)
        if out != text:
            path.write_text(out, encoding="utf-8")
            n += 1
            print(path.relative_to(ROOT))
    print(f"updated {n} files")


if __name__ == "__main__":
    main()
