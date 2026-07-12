# deemsvc Tool Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the sandbox boundary — `ToolBroker` — that every agent role and the
Verifier invoke tools through: argv-only subprocess execution, environment scrubbing,
resource confinement, timeout kill, and structured stdout parsing. No model or
network calls in this plan; it is pure subprocess sandboxing tested against fixture
git repositories.

**Architecture:** A `ToolBroker(workdir)` renders a validated argv from a `ToolSpec`
template, launches it with `asyncio.create_subprocess_exec` under `start_new_session`
and `setrlimit` confinement, classifies the exit code against the spec's
`ok_exits`/`signal_exits`, and hands the parsed output back as a `ToolOutcome`. This
plan depends on `deemsvc-orchestrator-core` only for its package scaffold conventions
(pyproject layout) — no runtime dependency on the orchestrator module.

**Tech Stack:** Python 3.11+, `asyncio`, `resource` (POSIX), `xml.etree.ElementTree`,
`pytest`, `pytest-asyncio`.

## Global Constraints

- POSIX only (macOS/Linux) — this plan uses `resource.setrlimit` and `os.killpg`,
  which do not exist on Windows. Per `docs/specs/2026-07-12-fable5-engine-rebuild-design.md`
  §6, this is a documented gap, not a bug to fix here.
  Sandboxing.
- Tools are invoked as fixed argv vectors via `asyncio.create_subprocess_exec` —
  never a shell string. Placeholder substitution is validated against
  `_SAFE_ARG = re.compile(r"[A-Za-z0-9_.:/@=\-\[\]]+")`; anything else raises
  `ValueError` before the subprocess is spawned.
- **Deviation from the blueprint, called out explicitly:** `docs/AI-CODING-AGENT-ARCHITECTURAL-BLUEPRINT.md`
  §5.2's `REGISTRY` only defines `pytest-junit` and `ruff-json`, but its own Verifier
  code (§6.1) calls `broker.invoke("git", sub=..., a1=..., a2=..., a3=..., a4=...)`
  with a variable number of positional args — no `git` `ToolSpec` is ever defined, and
  the fixed-length `_render` template as written would `KeyError` on any call that
  omits a trailing arg (e.g. `git rev-parse HEAD` only supplies `sub` and `a1`). This
  plan fixes both: `_render` treats an unset or empty-string placeholder as "omit this
  argv element" instead of requiring every named slot, and a `git` `ToolSpec` with five
  optional positional slots (`{a1}`..`{a5}`) is added to `REGISTRY`, backed by a new
  `_parse_raw` parser returning `{"raw": <stdout text>, "stdout": <stdout text>}` (both
  keys populated because the blueprint's callers read `.parsed["raw"]` in one place and
  `.parsed["stdout"]` in another).
- Source reference: `docs/AI-CODING-AGENT-ARCHITECTURAL-BLUEPRINT.md` §5 (the
  `sandbox/broker.py` reference implementation this plan adapts and corrects).

---

### Task 1: ToolOutcome/ToolSpec types and safe argv rendering

**Files:**
- Create: `deemsvc/src/deemsvc/sandbox/__init__.py`
- Create: `deemsvc/src/deemsvc/sandbox/broker.py`
- Create: `deemsvc/tests/test_broker_render.py`

**Interfaces:**
- Produces: `OutcomeKind` (StrEnum: `TOOL_OK, TASK_SIGNAL, TOOL_MISUSE, TIMEOUT, INFRA_FAILURE`), `ToolSpec` (frozen dataclass: `name, argv: tuple[str,...], timeout_s: int, ok_exits: frozenset[int], signal_exits: frozenset[int], parser: Callable[[bytes,str],dict], max_output: int = 2<<20`), `ToolOutcome` (frozen dataclass: `kind, exit_code, parsed, stdout_truncated, stderr_tail, wall_ms`), `ToolBroker._render(spec, args) -> list[str]` (method, exercised directly in this task's tests via a broker instance).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_broker_render.py`:

```python
import pytest

from deemsvc.sandbox.broker import REGISTRY, ToolBroker


def test_render_substitutes_placeholders():
    broker = ToolBroker("/tmp")
    argv = broker._render(REGISTRY["git"], {"sub": "rev-parse", "a1": "HEAD"})
    assert argv == ["git", "rev-parse", "HEAD"]


def test_render_omits_unset_optional_placeholders():
    broker = ToolBroker("/tmp")
    argv = broker._render(REGISTRY["git"], {"sub": "status"})
    assert argv == ["git", "status"]


def test_render_omits_empty_string_placeholders():
    broker = ToolBroker("/tmp")
    argv = broker._render(REGISTRY["git"], {"sub": "log", "a1": "", "a2": "-1"})
    assert argv == ["git", "log", "-1"]


def test_render_rejects_unsafe_characters():
    broker = ToolBroker("/tmp")
    with pytest.raises(ValueError, match="unsafe argument"):
        broker._render(REGISTRY["git"], {"sub": "log; rm -rf /"})


def test_render_allows_the_full_safe_character_class():
    broker = ToolBroker("/tmp")
    # letters, digits, underscore, dot, colon, slash, @, =, dash, brackets
    argv = broker._render(REGISTRY["git"], {"sub": "diff", "a1": "HEAD~1..HEAD",
                                            "a2": "--", "a3": "path/to/file.py"})
    assert argv == ["git", "diff", "HEAD~1..HEAD", "--", "path/to/file.py"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_broker_render.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'deemsvc.sandbox'`

- [ ] **Step 3: Implement the types and safe rendering**

`deemsvc/src/deemsvc/sandbox/__init__.py`: empty file.

`deemsvc/src/deemsvc/sandbox/broker.py`:

```python
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_broker_render.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/sandbox/__init__.py deemsvc/src/deemsvc/sandbox/broker.py \
        deemsvc/tests/test_broker_render.py
git commit -m "feat(deemsvc): add ToolBroker argv rendering with the git tool spec"
```

---

### Task 2: subprocess invocation, exit-code classification, and output capping

**Files:**
- Modify: `deemsvc/src/deemsvc/sandbox/broker.py`
- Create: `deemsvc/tests/fixtures/echo_repo/.gitkeep`
- Create: `deemsvc/tests/test_broker_invoke.py`

**Interfaces:**
- Consumes: `ToolSpec`, `ToolOutcome`, `OutcomeKind`, `REGISTRY`, `ToolBroker._render` from Task 1.
- Produces: `ToolBroker.invoke(tool: str, **args: str) -> ToolOutcome` (async method), `ToolBroker._drain(stream, cap) -> tuple[bytes, bool]` (staticmethod).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/fixtures/echo_repo/.gitkeep`: empty file (placeholder so the fixture
directory exists in git; the test below initializes a real git repo inside a `tmp_path`
copy rather than mutating this fixture directory).

`deemsvc/tests/test_broker_invoke.py`:

```python
import subprocess

import pytest

from deemsvc.sandbox.broker import OutcomeKind, ToolBroker


@pytest.fixture
def git_repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    (repo / "README.md").write_text("hello\n")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
    return repo


@pytest.mark.asyncio
async def test_invoke_git_rev_parse_returns_tool_ok(git_repo):
    broker = ToolBroker(str(git_repo))
    outcome = await broker.invoke("git", sub="rev-parse", a1="HEAD")
    assert outcome.kind is OutcomeKind.TOOL_OK
    assert outcome.exit_code == 0
    assert len(outcome.parsed["stdout"].strip()) == 40  # a full SHA


@pytest.mark.asyncio
async def test_invoke_unknown_git_subcommand_is_tool_misuse(git_repo):
    broker = ToolBroker(str(git_repo))
    outcome = await broker.invoke("git", sub="not-a-real-subcommand")
    assert outcome.kind is OutcomeKind.TOOL_MISUSE


@pytest.mark.asyncio
async def test_invoke_populates_wall_ms(git_repo):
    broker = ToolBroker(str(git_repo))
    outcome = await broker.invoke("git", sub="rev-parse", a1="HEAD")
    assert outcome.wall_ms >= 0


@pytest.mark.asyncio
async def test_drain_flags_truncation_without_blocking(git_repo):
    broker = ToolBroker(str(git_repo))
    proc = await __import__("asyncio").create_subprocess_exec(
        "python3", "-c", "print('x' * 200)",
        stdout=__import__("asyncio").subprocess.PIPE,
        stderr=__import__("asyncio").subprocess.DEVNULL,
    )
    data, truncated = await broker._drain(proc.stdout, cap=10)
    await proc.wait()
    assert len(data) == 10
    assert truncated is True
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_broker_invoke.py -v`
Expected: FAIL with `AttributeError: 'ToolBroker' object has no attribute 'invoke'`

- [ ] **Step 3: Implement invoke, _drain, and _confine**

Add to `deemsvc/src/deemsvc/sandbox/broker.py` (add `import asyncio`, `import os`,
`import resource`, `import signal` to the imports):

```python
import asyncio
import os
import resource
import signal


def _confine(timeout_s: int) -> Callable[[], None]:
    def hook() -> None:
        resource.setrlimit(resource.RLIMIT_CPU, (timeout_s, timeout_s + 10))
        try:
            resource.setrlimit(resource.RLIMIT_AS, (6 << 30, 6 << 30))
        except ValueError:
            pass  # RLIMIT_AS is unconditionally unsettable on macOS/Darwin;
                  # CPU/NOFILE/FSIZE below remain enforced everywhere.
        resource.setrlimit(resource.RLIMIT_NOFILE, (512, 512))
        resource.setrlimit(resource.RLIMIT_FSIZE, (512 << 20, 512 << 20))
    return hook
```

Add these methods to `ToolBroker` (after `_render`):

```python
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

        # 1-4 (not 2-4) because real git returns exit 1 for an unknown subcommand.
        # This range is tuned for git's "misuse" convention specifically — a future
        # REGISTRY entry (a non-git tool, or a git subcommand like merge/cherry-pick/
        # bisect where exit 1 is a legitimate conflict, not misuse) must pre-empt
        # this fallback via its own ok_exits/signal_exits rather than relying on it.
        kind = OutcomeKind.TOOL_MISUSE if 1 <= code <= 4 else OutcomeKind.INFRA_FAILURE
        return ToolOutcome(kind, code, {}, truncated,
                           stderr[-2048:].decode(errors="replace"), wall_ms)
```

**Note (corrected after implementation, three fixes verified by review):**
1. `_confine` wraps `RLIMIT_AS` in try/except — it's unconditionally unsettable on
   macOS/Darwin (confirmed by direct probe across 1 GiB-256 GiB limits); the other
   three rlimits remain unconditionally enforced everywhere.
2. `invoke`'s misuse-exit-code range widened from `2-4` to `1-4` — real `git` returns
   exit 1 for an unknown subcommand, not 2-4, confirmed against every git subcommand
   this `REGISTRY["git"]` entry is used for (rev-parse, worktree add/remove, diff);
   none of their legitimate failure modes land in 1-4, only "not a git command" does.
3. `_drain`'s truncation flag now also fires when a single `read()` chunk alone
   exceeds `cap`, not only on a subsequent chunk after the buffer is already full —
   the original code never set `truncated=True` when an entire over-cap output
   arrived in one chunk, which is exactly what this task's own truncation test does.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_broker_invoke.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/sandbox/broker.py deemsvc/tests/fixtures/echo_repo/.gitkeep \
        deemsvc/tests/test_broker_invoke.py
git commit -m "feat(deemsvc): add ToolBroker.invoke with rlimit confinement and output capping"
```

---

### Task 3: pytest-junit tool spec

**Files:**
- Modify: `deemsvc/src/deemsvc/sandbox/broker.py`
- Create: `deemsvc/tests/fixtures/pytest_repo/test_sample.py`
- Create: `deemsvc/tests/fixtures/pytest_repo/pytest.ini`
- Create: `deemsvc/tests/test_broker_pytest_junit.py`

**Interfaces:**
- Consumes: `ToolBroker.invoke`, `ToolSpec`, `REGISTRY` from Tasks 1-2.
- Produces: `REGISTRY["pytest-junit"]`, `_parse_junit(stdout: bytes, workdir: str) -> dict` (returns `{"cases": {test_id: "PASS"|"FAIL:<head>"|"SKIP"}, "total": int}`).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/fixtures/pytest_repo/test_sample.py`:

```python
def test_passes():
    assert 1 + 1 == 2


def test_fails():
    assert 1 + 1 == 3, "arithmetic is broken"


def test_skipped():
    import pytest
    pytest.skip("not applicable")
```

`deemsvc/tests/fixtures/pytest_repo/pytest.ini`:

```ini
[pytest]
addopts = -p no:cacheprovider
```

`deemsvc/tests/test_broker_pytest_junit.py`:

```python
import shutil

import pytest

from deemsvc.sandbox.broker import OutcomeKind, ToolBroker

FIXTURE = "tests/fixtures/pytest_repo"


@pytest.fixture
def pytest_repo(tmp_path):
    dest = tmp_path / "pytest_repo"
    shutil.copytree(FIXTURE, dest)
    return dest


@pytest.mark.asyncio
async def test_pytest_junit_reports_task_signal_on_failure(pytest_repo):
    broker = ToolBroker(str(pytest_repo))
    outcome = await broker.invoke("pytest-junit", selector="test_sample.py")
    assert outcome.kind is OutcomeKind.TASK_SIGNAL  # a failing suite is a successful invocation
    assert outcome.parsed["total"] == 3
    assert outcome.parsed["cases"]["::test_passes"] == "PASS"
    assert outcome.parsed["cases"]["::test_fails"].startswith("FAIL:")
    assert outcome.parsed["cases"]["::test_skipped"] == "SKIP"


@pytest.mark.asyncio
async def test_pytest_junit_reports_tool_ok_when_all_pass(pytest_repo):
    broker = ToolBroker(str(pytest_repo))
    outcome = await broker.invoke("pytest-junit", selector="test_sample.py::test_passes")
    assert outcome.kind is OutcomeKind.TOOL_OK
    assert outcome.parsed["cases"]["::test_passes"] == "PASS"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pip install pytest && .venv/bin/pytest tests/test_broker_pytest_junit.py -v`
Expected: FAIL with `KeyError: 'pytest-junit'`

- [ ] **Step 3: Implement the pytest-junit tool spec**

Add to `deemsvc/src/deemsvc/sandbox/broker.py` (add `import xml.etree.ElementTree as ET`
to the imports):

```python
import xml.etree.ElementTree as ET


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
```

Add to `REGISTRY` (in the same dict literal as `"git"`):

```python
    "pytest-junit": ToolSpec(
        name="pytest-junit",
        argv=("python3", "-m", "pytest", "-q", "-p", "no:cacheprovider",
              "--junitxml=.deemsvc/junit.xml", "{selector}"),
        timeout_s=600,
        ok_exits=frozenset({0}),
        signal_exits=frozenset({1, 5}),       # 1 = failures, 5 = nothing collected
        parser=_parse_junit,
    ),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_broker_pytest_junit.py -v`
Expected: 2 passed

Note: `classname` for a top-level test function in a single file is empty, hence the
`"::test_passes"` id shape (matching the fixture's flat layout) — this is intentional
and mirrors real pytest JUnit output for module-level test functions.

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/sandbox/broker.py deemsvc/tests/fixtures/pytest_repo/ \
        deemsvc/tests/test_broker_pytest_junit.py
git commit -m "feat(deemsvc): add pytest-junit tool spec with TASK_SIGNAL classification"
```

---

### Task 4: ruff-json tool spec

**Files:**
- Modify: `deemsvc/src/deemsvc/sandbox/broker.py`
- Create: `deemsvc/tests/fixtures/ruff_repo/bad.py`
- Create: `deemsvc/tests/test_broker_ruff.py`

**Interfaces:**
- Consumes: `ToolBroker.invoke`, `ToolSpec`, `REGISTRY` from Tasks 1-2.
- Produces: `REGISTRY["ruff-json"]`, `_parse_ruff(stdout: bytes, workdir: str) -> dict` (returns `{"findings": [{"path", "line", "code", "msg"}, ...]}`).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/fixtures/ruff_repo/bad.py`:

```python
import os
import sys


def unused_import_example():
    return 1
```

(`sys` is imported but unused — triggers ruff's `F401`.)

`deemsvc/tests/test_broker_ruff.py`:

```python
import shutil

import pytest

from deemsvc.sandbox.broker import OutcomeKind, ToolBroker

FIXTURE = "tests/fixtures/ruff_repo"


@pytest.fixture
def ruff_repo(tmp_path):
    dest = tmp_path / "ruff_repo"
    shutil.copytree(FIXTURE, dest)
    return dest


@pytest.mark.asyncio
async def test_ruff_reports_unused_import(ruff_repo):
    broker = ToolBroker(str(ruff_repo))
    outcome = await broker.invoke("ruff-json", path="bad.py")
    assert outcome.kind is OutcomeKind.TOOL_OK  # --exit-zero: findings aren't a nonzero exit
    codes = [f["code"] for f in outcome.parsed["findings"]]
    assert "F401" in codes
    finding = next(f for f in outcome.parsed["findings"] if f["code"] == "F401")
    assert finding["path"] == "bad.py"
    assert finding["line"] == 2  # `import sys`
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pip install ruff && .venv/bin/pytest tests/test_broker_ruff.py -v`
Expected: FAIL with `KeyError: 'ruff-json'`

- [ ] **Step 3: Implement the ruff-json tool spec**

Add to `deemsvc/src/deemsvc/sandbox/broker.py` (add `import json` to the imports):

```python
import json


def _parse_ruff(stdout: bytes, workdir: str) -> dict:
    findings = json.loads(stdout or b"[]")
    return {"findings": [
        {"path": f["filename"], "line": f["location"]["row"],
         "code": f["code"], "msg": f["message"][:200]}
        for f in findings
    ]}
```

Add to `REGISTRY`:

```python
    "ruff-json": ToolSpec(
        name="ruff-json",
        argv=("python3", "-m", "ruff", "check", "--output-format", "json",
              "--exit-zero", "{path}"),
        timeout_s=120,
        ok_exits=frozenset({0}),
        signal_exits=frozenset(),
        parser=_parse_ruff,
    ),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_broker_ruff.py -v`
Expected: 1 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/sandbox/broker.py deemsvc/tests/fixtures/ruff_repo/ \
        deemsvc/tests/test_broker_ruff.py
git commit -m "feat(deemsvc): add ruff-json tool spec"
```

---

### Task 5: Timeout enforcement kills the whole process group

**Files:**
- Create: `deemsvc/src/deemsvc/sandbox/testing_tools.py`
- Modify: `deemsvc/src/deemsvc/sandbox/broker.py`
- Create: `deemsvc/tests/test_broker_timeout.py`

**Interfaces:**
- Consumes: `ToolBroker.invoke`, `ToolOutcome`, `OutcomeKind` from Tasks 1-2.
- Produces: `REGISTRY["sleep"]` (a test-only tool spec used to exercise the timeout path — not used by the Verifier or any agent role).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_broker_timeout.py`:

```python
import time

import pytest

from deemsvc.sandbox.broker import OutcomeKind, ToolBroker


@pytest.mark.asyncio
async def test_slow_tool_is_killed_within_its_timeout(tmp_path):
    broker = ToolBroker(str(tmp_path))
    start = time.monotonic()
    outcome = await broker.invoke("sleep", seconds="5")  # spec timeout is 1s — see Step 3
    elapsed = time.monotonic() - start
    assert outcome.kind is OutcomeKind.TIMEOUT
    assert elapsed < 3  # killed well before the child's own 5s sleep would finish


@pytest.mark.asyncio
async def test_fast_tool_under_timeout_succeeds(tmp_path):
    broker = ToolBroker(str(tmp_path))
    outcome = await broker.invoke("sleep", seconds="0")
    assert outcome.kind is OutcomeKind.TOOL_OK
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_broker_timeout.py -v`
Expected: FAIL with `KeyError: 'sleep'`

- [ ] **Step 3: Add a test-only sleep tool spec**

`deemsvc/src/deemsvc/sandbox/testing_tools.py`:

```python
"""Tool specs used only by deemsvc's own test suite — never exposed to an agent
role or the Verifier. Registered into the shared REGISTRY at import time so tests
can exercise ToolBroker.invoke's timeout and confinement paths without a real
long-running tool."""
from __future__ import annotations

from .broker import REGISTRY, ToolSpec, _parse_raw


REGISTRY["sleep"] = ToolSpec(
    name="sleep",
    argv=("python3", "-c", "import sys, time; time.sleep(float(sys.argv[1]))", "{seconds}"),
    timeout_s=1,
    ok_exits=frozenset({0}),
    signal_exits=frozenset(),
    parser=_parse_raw,
)
```

Update `deemsvc/tests/test_broker_timeout.py`'s imports to register the test tool
before the test functions run — add this import at the top of the file, immediately
after the existing imports:

```python
from deemsvc.sandbox import testing_tools  # noqa: F401 — registers REGISTRY["sleep"]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_broker_timeout.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/sandbox/testing_tools.py deemsvc/tests/test_broker_timeout.py
git commit -m "test(deemsvc): verify ToolBroker timeout kills the whole process group"
```

---

### Task 6: Full sandbox test suite passes together

**Files:**
- No new files — this task is a verification checkpoint.

- [ ] **Step 1: Run the full deemsvc test suite**

Run: `cd deemsvc && .venv/bin/pytest -v`
Expected: every test from `deemsvc-orchestrator-core` and this plan passes together
(50+ tests, 0 failures). If `pytest-junit` or `ruff-json` tests fail because those
tools aren't on `PATH` inside the sandbox's scrubbed env, confirm `ruff` is installed
into `.venv` (`.venv/bin/pip show ruff`) and that `ToolBroker._env["PATH"]` includes
the directory `ruff`/`pytest` actually resolve to in this environment — if it doesn't,
that is a real finding to fix, not a test to skip: production tool availability must
match what the sandboxed `PATH` grants.

- [ ] **Step 2: Commit any fixes discovered in Step 1**

```bash
git add -A deemsvc/
git commit -m "fix(deemsvc): reconcile sandbox PATH with installed tool locations"
```

(Only run this step if Step 1 required a fix. If the full suite passed cleanly on the
first run, skip this step — there is nothing to commit.)
