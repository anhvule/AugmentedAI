from __future__ import annotations

import os
import shutil
from pathlib import Path

MEMORY_TOOL = {"type": "memory_20250818", "name": "memory"}


class MemoryStore:
    """Client-side backend for the Fable 5 memory tool. Every path the model
    supplies is resolved and confined to `root/memories` before any filesystem
    call — a model-supplied '../../etc/passwd' resolves outside root and is
    rejected, not opened."""

    def __init__(self, root: str):
        self.root = Path(root, "memories").resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, rel: str) -> Path:
        # Strip a leading "/memories" the model prepends per the tool's convention.
        rel = rel.removeprefix("/memories").lstrip("/")
        p = (self.root / rel).resolve()
        if p != self.root and self.root not in p.parents:
            raise ValueError(f"path escapes memory root: {rel!r}")
        return p

    def handle(self, cmd: dict) -> str:
        """Dispatch one memory tool_use.input. Returns the tool_result string."""
        op = cmd["command"]
        if op == "view":
            p = self._resolve(cmd["path"])
            if p.is_dir():
                return "\n".join(sorted(c.name for c in p.iterdir())) or "(empty)"
            text = p.read_text(encoding="utf-8").splitlines()
            rng = cmd.get("view_range")
            if rng:
                text = text[rng[0] - 1 : rng[1]]
            return "\n".join(f"{i+1}\t{ln}" for i, ln in enumerate(text))
        if op == "create":
            p = self._resolve(cmd["path"])
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(cmd["file_text"], encoding="utf-8")
            return f"created {cmd['path']}"
        if op == "str_replace":
            p = self._resolve(cmd["path"])
            body = p.read_text(encoding="utf-8")
            if body.count(cmd["old_str"]) != 1:
                return "error: old_str must match exactly once"
            p.write_text(body.replace(cmd["old_str"], cmd["new_str"]), encoding="utf-8")
            return "ok"
        if op == "insert":
            p = self._resolve(cmd["path"])
            lines = p.read_text(encoding="utf-8").splitlines(keepends=True)
            lines.insert(cmd["insert_line"], cmd["insert_text"] + "\n")
            p.write_text("".join(lines), encoding="utf-8")
            return "ok"
        if op == "rename":
            src, dst = self._resolve(cmd["old_path"]), self._resolve(cmd["new_path"])
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(src, dst)
            return f"renamed -> {cmd['new_path']}"
        if op == "delete":
            p = self._resolve(cmd["path"])
            (shutil.rmtree if p.is_dir() else os.unlink)(p)
            return f"deleted {cmd['path']}"
        return f"error: unknown command {op!r}"
