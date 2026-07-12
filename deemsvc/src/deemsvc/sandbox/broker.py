from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Callable

_SAFE_ARG = re.compile(r"[A-Za-z0-9_.:/@=\-\[\]~]+")
_MAX_OUTPUT_DEFAULT = 2 << 20  # 2 MiB


class OutcomeKind(StrEnum):
    TOOL_OK = "tool_ok"            # tool ran; semantics say "success"
    TASK_SIGNAL = "task_signal"    # tool ran; semantics say "work has defects" (e.g. failing tests)
    TOOL_MISUSE = "tool_misuse"    # bad invocation — bounce to caller as its own error
    TIMEOUT = "timeout"
    INFRA_FAILURE = "infra_failure"


@dataclass(frozen=True)
class ToolSpec:
    name: str
    argv: tuple[str, ...]                    # templated: "{selector}", "{a1}", ...
    timeout_s: int
    ok_exits: frozenset[int]                 # -> TOOL_OK
    signal_exits: frozenset[int]             # -> TASK_SIGNAL
    parser: Callable[[bytes, str], dict]     # (stdout, workdir) -> structured payload
    max_output: int = _MAX_OUTPUT_DEFAULT


@dataclass(frozen=True)
class ToolOutcome:
    kind: OutcomeKind
    exit_code: int | None
    parsed: dict
    stdout_truncated: bool
    stderr_tail: str
    wall_ms: int


def _parse_raw(stdout: bytes, workdir: str) -> dict:
    text = stdout.decode(errors="replace")
    return {"raw": text, "stdout": text}


REGISTRY: dict[str, ToolSpec] = {
    "git": ToolSpec(
        name="git",
        # a1..a5 are optional positional slots — _render omits any that are unset
        # or empty, so `git.invoke("git", sub="rev-parse", a1="HEAD")` and
        # `git.invoke("git", sub="worktree", a1="add", a2="--detach", a3=path, a4=ref)`
        # both render correctly from the same template.
        argv=("git", "{sub}", "{a1}", "{a2}", "{a3}", "{a4}", "{a5}"),
        timeout_s=60,
        ok_exits=frozenset({0}),
        signal_exits=frozenset(),
        parser=_parse_raw,
        max_output=8 << 20,
    ),
}


class ToolBroker:
    def __init__(self, workdir: str):
        self.workdir = workdir
        self._env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": workdir,
            "PYTHONDONTWRITEBYTECODE": "1",
            "NO_COLOR": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "CI": "1",
        }

    def _render(self, spec: ToolSpec, args: dict[str, str]) -> list[str]:
        argv: list[str] = []
        for token in spec.argv:
            if token.startswith("{") and token.endswith("}"):
                value = args.get(token[1:-1], "")
                if value == "":
                    continue  # optional slot, omitted
                if not _SAFE_ARG.fullmatch(value):
                    raise ValueError(f"unsafe argument for {spec.name}: {value!r}")
                argv.append(value)
            else:
                argv.append(token)
        return argv
