from __future__ import annotations

import asyncio
import json
import os
import re
import resource
import signal
import sys
import xml.etree.ElementTree as ET
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


def _parse_junit(stdout: bytes, workdir: str) -> dict:
    """pytest writes JUnit XML to a known path; stdout is advisory only."""
    report = os.path.join(workdir, ".deemsvc", "junit.xml")
    cases: dict[str, str] = {}
    root = ET.parse(report).getroot()
    for tc in root.iter("testcase"):
        tid = f"{tc.get('classname', '')}::{tc.get('name', '')}"
        child = next(iter(tc), None)
        if child is None:
            cases[tid] = "PASS"
        elif child.tag in ("failure", "error"):
            head = (child.get("message") or child.text or "")[:400]
            cases[tid] = f"FAIL:{head}"
        elif child.tag == "skipped":
            cases[tid] = "SKIP"
    return {"cases": cases, "total": len(cases)}


def _parse_ruff(stdout: bytes, workdir: str) -> dict:
    findings = json.loads(stdout or b"[]")
    return {"findings": [
        {"path": os.path.relpath(f["filename"], workdir), "line": f["location"]["row"],
         "code": f["code"], "msg": f["message"][:200]}
        for f in findings
    ]}


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
    "pytest-junit": ToolSpec(
        name="pytest-junit",
        argv=("python3", "-m", "pytest", "-q", "-p", "no:cacheprovider",
              "--junitxml=.deemsvc/junit.xml", "{selector}"),
        timeout_s=600,
        ok_exits=frozenset({0}),
        signal_exits=frozenset({1, 5}),       # 1 = failures, 5 = nothing collected
        parser=_parse_junit,
    ),
    "ruff-json": ToolSpec(
        name="ruff-json",
        argv=("python3", "-m", "ruff", "check", "--output-format", "json",
              "--exit-zero", "{path}"),
        timeout_s=120,
        ok_exits=frozenset({0}),
        signal_exits=frozenset(),
        parser=_parse_ruff,
    ),
}


def _confine(timeout_s: int) -> Callable[[], None]:
    def hook() -> None:
        resource.setrlimit(resource.RLIMIT_CPU, (timeout_s, timeout_s + 10))
        try:
            resource.setrlimit(resource.RLIMIT_AS, (6 << 30, 6 << 30))
        except (ValueError, OSError):
            # RLIMIT_AS cannot be lowered on some platforms (e.g. macOS/Darwin
            # rejects it unconditionally with EINVAL) — best-effort only.
            pass
        resource.setrlimit(resource.RLIMIT_NOFILE, (512, 512))
        resource.setrlimit(resource.RLIMIT_FSIZE, (512 << 20, 512 << 20))
    return hook


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
        if argv and argv[0] == "python3":
            # Resolve to the interpreter actually running this broker (guaranteed
            # by pyproject's requires-python + the project's venv to have
            # pytest/pytest-asyncio installed) rather than whatever "python3"
            # happens to mean on the scrubbed subprocess PATH.
            argv[0] = sys.executable
        return argv

    @staticmethod
    async def _drain(stream: asyncio.StreamReader, cap: int) -> tuple[bytes, bool]:
        buf, truncated = bytearray(), False
        while chunk := await stream.read(65536):
            if len(buf) < cap:
                take = chunk[: cap - len(buf)]
                buf += take
                if len(take) < len(chunk):
                    truncated = True   # this chunk alone overflowed the cap
            else:
                truncated = True   # keep draining so the child never blocks on a full pipe
        return bytes(buf), truncated

    async def invoke(self, tool: str, **args: str) -> ToolOutcome:
        spec = REGISTRY[tool]
        argv = self._render(spec, args)
        os.makedirs(os.path.join(self.workdir, ".deemsvc"), exist_ok=True)
        t0 = asyncio.get_running_loop().time()

        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=self.workdir,
            env=self._env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
            preexec_fn=_confine(spec.timeout_s),
        )
        out_task = asyncio.create_task(self._drain(proc.stdout, spec.max_output))
        err_task = asyncio.create_task(self._drain(proc.stderr, 64 << 10))

        try:
            code = await asyncio.wait_for(proc.wait(), timeout=spec.timeout_s)
        except asyncio.TimeoutError:
            os.killpg(proc.pid, signal.SIGKILL)   # whole group — child spawns included
            await proc.wait()
            out_task.cancel(); err_task.cancel()
            return ToolOutcome(OutcomeKind.TIMEOUT, None, {}, False,
                               stderr_tail="", wall_ms=spec.timeout_s * 1000)

        stdout, truncated = await out_task
        stderr, _ = await err_task
        wall_ms = int((asyncio.get_running_loop().time() - t0) * 1000)

        if code in spec.ok_exits or code in spec.signal_exits:
            try:
                parsed = spec.parser(stdout, self.workdir)
            except Exception as exc:            # report artifact missing / malformed
                return ToolOutcome(OutcomeKind.INFRA_FAILURE, code,
                                   {"parse_error": repr(exc)}, truncated,
                                   stderr[-2048:].decode(errors="replace"), wall_ms)
            kind = OutcomeKind.TOOL_OK if code in spec.ok_exits else OutcomeKind.TASK_SIGNAL
            return ToolOutcome(kind, code, parsed, truncated,
                               stderr[-2048:].decode(errors="replace"), wall_ms)

        # 1-4 (not the blueprint's original 2-4) because real git returns exit 1 for
        # an unknown subcommand. This range is tuned for git's "misuse" convention
        # specifically — a future REGISTRY entry (a non-git tool, or a git subcommand
        # like merge/cherry-pick/bisect where exit 1 is a legitimate conflict, not
        # misuse) must pre-empt this fallback via its own ok_exits/signal_exits rather
        # than relying on this default.
        kind = OutcomeKind.TOOL_MISUSE if 1 <= code <= 4 else OutcomeKind.INFRA_FAILURE
        return ToolOutcome(kind, code, {}, truncated,
                           stderr[-2048:].decode(errors="replace"), wall_ms)
