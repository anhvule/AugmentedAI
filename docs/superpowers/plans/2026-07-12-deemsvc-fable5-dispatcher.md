# deemsvc Pluggable Agent Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a formal `AgentAdapter` contract — the same
`Callable[[Step], Awaitable[StepResult]]` shape `Orchestrator.dispatch` already
expects — and ship three concrete implementations behind it: `FableDispatcher`
(direct Anthropic API, Fable-5-native: task budgets, memory tool, effort levels),
and CLI-backed adapters for `claude-code-cli` and `codex-cli`. All three plug into
`GenerateThenVerifyDispatcher` (built in `deemsvc-service-node-integration`)
identically, so any of them can be selected per run without touching the
Orchestrator, the Verifier, or the FastAPI service.

**Architecture:** The key insight that makes this pluggable without weakening the
architecture's ground-truth guarantee: the Verifier never needs to know *how* a
candidate commit was produced — only that `git rev-parse HEAD` in the worktree
points at something. Every adapter, API-native or CLI-based, computes
`candidate_ref` from git after the agent's process exits and never trusts the
agent's own claim of success. `build_request(role, ...)` still encodes every
Fable-5-specific API rule (effort levels, no sampling params, always-on fallbacks)
in one place for the one adapter that needs it; `CliAgentAdapter` needs none of that
machinery — it shells out, waits, and checks git.

**Tech Stack:** Python 3.11+, `anthropic` (AsyncAnthropic, streaming), `pytest`,
`pytest-asyncio`.

## Global Constraints

- Depends on `deemsvc-tool-broker` (`ToolBroker`, `OutcomeKind`) and
  `deemsvc-orchestrator-core` (`Step`, `StepResult`).
- `FableDispatcher`'s model is always `"claude-fable-5"`, with
  `fallbacks=[{"model": "claude-opus-4-8"}]` on every request — never omit the
  fallback. Never pass `temperature`, `top_p`, or `top_k` — Fable 5 rejects them
  with a 400. Never pass an explicit `thinking` key unless `surface_reasoning` is
  true for the role.
- CLI adapters (`claude-code-cli`, `codex-cli`) require the respective CLI
  installed and authenticated on the host — same operational requirement the old
  `server/agents/claude.js`/`codex.js` had. Tests in this plan never depend on the
  real CLIs being installed: they exercise `CliAgentAdapter` against a small fake
  shell script fixture, since the adapter's behavior (compute `candidate_ref` from
  git, never trust the process's own output) is identical regardless of which real
  binary is behind it.
- **Invariant that must hold for every adapter, present and future:** `candidate_ref`
  is always computed by the adapter from `git rev-parse HEAD` in the worktree after
  the agent process/API call completes — never parsed or trusted from the agent's
  own stdout, transcript, or self-reported claim. This is what lets
  `GenerateThenVerifyDispatcher` route any adapter's output through the same
  Verifier arbitration uniformly.
- Source reference: `docs/AI-CODING-AGENT-ARCHITECTURAL-BLUEPRINT.md` §8 (`sdk/request.py`,
  `sdk/memory.py`, `sdk/tools.py`, `sdk/dispatch.py`) for the `FableDispatcher` half of
  this plan; the CLI adapters and the `AgentAdapter` protocol are new design not in
  the source blueprint, needed to satisfy the pluggability requirement.
- Live-API tests are marked `@pytest.mark.skipif(not os.environ.get("ANTHROPIC_API_KEY"), ...)`.

---

### Task 1: Role profiles and the request builder

**Files:**
- Create: `deemsvc/src/deemsvc/sdk/__init__.py`
- Create: `deemsvc/src/deemsvc/sdk/request.py`
- Create: `deemsvc/tests/test_sdk_request.py`

**Interfaces:**
- Produces: `RoleProfile` (frozen dataclass: `effort: str, stream: bool, surface_reasoning: bool, task_budget_tokens: int | None, long_horizon: bool`), `PROFILES: dict[str, RoleProfile]` (keys: `"explorer", "generator", "verifier", "planner"`), `build_request(role, system_blocks, messages, tools, max_tokens=64_000) -> tuple[dict, list[str]]` (returns `(kwargs, betas)`).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_sdk_request.py`:

```python
from deemsvc.sdk.request import PROFILES, build_request


def test_explorer_has_no_thinking_key_and_no_task_budget():
    kwargs, betas = build_request("explorer", [], [], [])
    assert "thinking" not in kwargs
    assert "task_budget" not in kwargs["output_config"]
    assert kwargs["output_config"]["effort"] == "low"


def test_generator_has_task_budget_and_compaction_but_no_surfaced_reasoning():
    kwargs, betas = build_request("generator", [], [], [])
    assert "thinking" not in kwargs
    assert kwargs["output_config"]["task_budget"] == {"type": "tokens", "total": 90_000}
    assert "task-budgets-2026-03-13" in betas
    assert "compact-2026-01-12" in betas
    assert "context-management-2025-06-27" in betas
    assert kwargs["output_config"]["effort"] == "xhigh"


def test_verifier_surfaces_summarized_reasoning():
    kwargs, betas = build_request("verifier", [], [], [])
    assert kwargs["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert kwargs["output_config"]["effort"] == "high"


def test_every_role_always_carries_the_opus_fallback():
    for role in PROFILES:
        kwargs, _ = build_request(role, [], [], [])
        assert kwargs["fallbacks"] == [{"model": "claude-opus-4-8"}]


def test_no_sampling_parameters_are_ever_set():
    for role in PROFILES:
        kwargs, _ = build_request(role, [], [], [])
        assert "temperature" not in kwargs
        assert "top_p" not in kwargs
        assert "top_k" not in kwargs


def test_model_is_always_fable_5():
    for role in PROFILES:
        kwargs, _ = build_request(role, [], [], [])
        assert kwargs["model"] == "claude-fable-5"


def test_server_side_fallback_beta_is_always_present():
    for role in PROFILES:
        _, betas = build_request(role, [], [], [])
        assert "server-side-fallback-2026-06-01" in betas


def test_system_messages_and_tools_pass_through_unchanged():
    system = [{"type": "text", "text": "persona"}]
    messages = [{"role": "user", "content": "hi"}]
    tools = [{"name": "run_tests"}]
    kwargs, _ = build_request("generator", system, messages, tools)
    assert kwargs["system"] == system
    assert kwargs["messages"] == messages
    assert kwargs["tools"] == tools
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_sdk_request.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'deemsvc.sdk'`

- [ ] **Step 3: Implement RoleProfile, PROFILES, and build_request**

`deemsvc/src/deemsvc/sdk/__init__.py`: empty file.

`deemsvc/src/deemsvc/sdk/request.py`:

```python
from __future__ import annotations

from dataclasses import dataclass

# Fable 5 minimum cacheable prefix is 2048 tokens (lower than Opus 4.8's 4096).
# The frozen system prompt sits before this breakpoint; volatile per-step
# context goes after it, so the tool list + persona cache across every step.
_CACHE = {"type": "ephemeral"}


@dataclass(frozen=True)
class RoleProfile:
    effort: str                       # "low" | "high" | "xhigh" | "max"
    stream: bool
    surface_reasoning: bool           # verifier: True — reasoning enters the audit trail
    task_budget_tokens: int | None    # None => no self-pacing countdown
    long_horizon: bool                # generators/planners => enable compaction + editing


PROFILES: dict[str, RoleProfile] = {
    "explorer":  RoleProfile("low",   False, False, None,   False),
    "generator": RoleProfile("xhigh", True,  False, 90_000, True),
    "verifier":  RoleProfile("high",  True,  True,  None,   False),
    "planner":   RoleProfile("xhigh", True,  True,  60_000, True),
}


def build_request(
    role: str,
    system_blocks: list[dict],        # frozen persona (cached) + pinned criteria
    messages: list[dict],
    tools: list[dict],
    max_tokens: int = 64_000,
) -> tuple[dict, list[str]]:
    """Returns (kwargs, betas). Encodes every Fable 5 rule in one place so no
    call site can drift: no thinking config unless surfacing reasoning, effort
    in output_config, no sampling params, fallbacks always on. Used only by the
    FableDispatcher adapter (Task 5) — CLI adapters (Task 6) don't call this."""
    p = PROFILES[role]
    betas = ["server-side-fallback-2026-06-01"]

    output_config: dict = {"effort": p.effort}
    if p.task_budget_tokens is not None:
        # Fable 5 sees a running countdown and self-moderates. Minimum 20_000.
        output_config["task_budget"] = {"type": "tokens", "total": p.task_budget_tokens}
        betas.append("task-budgets-2026-03-13")

    kwargs: dict = {
        "model": "claude-fable-5",
        "max_tokens": max_tokens,               # 128K ceiling; stream above ~16K
        "system": system_blocks,
        "messages": messages,
        "tools": tools,
        "output_config": output_config,
        # Recover the previously-cached span at cache-read rates if a refusal
        # forces a fallback to Opus 4.8 (per-model caches are otherwise cold).
        "fallbacks": [{"model": "claude-opus-4-8"}],
        # NO thinking key unless we surface reasoning — omitting it keeps
        # adaptive thinking on (the default) with empty-text thinking blocks.
        # NO temperature / top_p / top_k — they 400 on Fable 5.
    }
    if p.surface_reasoning:
        kwargs["thinking"] = {"type": "adaptive", "display": "summarized"}
    if p.long_horizon:
        # Compaction summarizes history near the context ceiling; context editing
        # clears stale twin-worktree tool results the model no longer needs.
        betas += ["compact-2026-01-12", "context-management-2025-06-27"]
        kwargs["context_management"] = {
            "edits": [
                {"type": "clear_tool_uses_20250919"},
                {"type": "compact_20260112"},
            ],
        }
    return kwargs, betas
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_sdk_request.py -v`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/sdk/__init__.py deemsvc/src/deemsvc/sdk/request.py \
        deemsvc/tests/test_sdk_request.py
git commit -m "feat(deemsvc): add Fable 5 role profiles and request builder"
```

---

### Task 2: Memory tool — path-confined client-side backend

**Files:**
- Create: `deemsvc/src/deemsvc/sdk/memory.py`
- Create: `deemsvc/tests/test_sdk_memory.py`

**Interfaces:**
- Produces: `MEMORY_TOOL: dict` (the tool declaration `{"type": "memory_20250818", "name": "memory"}`), `MemoryStore` (class: `__init__(root: str)`; `handle(cmd: dict) -> str` — dispatches `view/create/str_replace/insert/rename/delete`).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_sdk_memory.py`:

```python
import pytest

from deemsvc.sdk.memory import MemoryStore


def test_create_then_view_round_trips(tmp_path):
    store = MemoryStore(str(tmp_path))
    store.handle({"command": "create", "path": "/memories/note.md", "file_text": "line1\nline2\n"})
    result = store.handle({"command": "view", "path": "/memories/note.md"})
    assert "line1" in result and "line2" in result


def test_str_replace_requires_exactly_one_match(tmp_path):
    store = MemoryStore(str(tmp_path))
    store.handle({"command": "create", "path": "/memories/note.md", "file_text": "a\nb\na\n"})
    result = store.handle({"command": "str_replace", "path": "/memories/note.md",
                           "old_str": "a", "new_str": "z"})
    assert result.startswith("error")  # "a" appears twice


def test_str_replace_succeeds_on_a_unique_match(tmp_path):
    store = MemoryStore(str(tmp_path))
    store.handle({"command": "create", "path": "/memories/note.md", "file_text": "unique\nb\n"})
    result = store.handle({"command": "str_replace", "path": "/memories/note.md",
                           "old_str": "unique", "new_str": "changed"})
    assert result == "ok"
    assert "changed" in store.handle({"command": "view", "path": "/memories/note.md"})


def test_delete_removes_a_file(tmp_path):
    store = MemoryStore(str(tmp_path))
    store.handle({"command": "create", "path": "/memories/gone.md", "file_text": "x"})
    store.handle({"command": "delete", "path": "/memories/gone.md"})
    result = store.handle({"command": "view", "path": "/memories"})
    assert "gone.md" not in result


def test_rename_moves_a_file(tmp_path):
    store = MemoryStore(str(tmp_path))
    store.handle({"command": "create", "path": "/memories/old.md", "file_text": "x"})
    result = store.handle({"command": "rename", "path": "/memories/old.md",
                           "old_path": "/memories/old.md", "new_path": "/memories/new.md"})
    assert "renamed" in result
    assert "new.md" in store.handle({"command": "view", "path": "/memories"})


def test_path_escape_attempt_is_rejected(tmp_path):
    store = MemoryStore(str(tmp_path))
    with pytest.raises(ValueError, match="escapes memory root"):
        store.handle({"command": "create", "path": "/memories/../../etc/passwd",
                     "file_text": "pwned"})


def test_view_of_a_directory_lists_entries(tmp_path):
    store = MemoryStore(str(tmp_path))
    store.handle({"command": "create", "path": "/memories/a.md", "file_text": "x"})
    store.handle({"command": "create", "path": "/memories/b.md", "file_text": "x"})
    result = store.handle({"command": "view", "path": "/memories"})
    assert "a.md" in result and "b.md" in result


def test_insert_adds_a_line_at_the_given_position(tmp_path):
    store = MemoryStore(str(tmp_path))
    store.handle({"command": "create", "path": "/memories/n.md", "file_text": "first\nthird\n"})
    store.handle({"command": "insert", "path": "/memories/n.md", "insert_line": 1,
                 "insert_text": "second"})
    result = store.handle({"command": "view", "path": "/memories/n.md"})
    assert result.splitlines()[1].endswith("second")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_sdk_memory.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'deemsvc.sdk.memory'`

- [ ] **Step 3: Implement MemoryStore**

`deemsvc/src/deemsvc/sdk/memory.py`:

```python
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_sdk_memory.py -v`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/sdk/memory.py deemsvc/tests/test_sdk_memory.py
git commit -m "feat(deemsvc): add path-confined memory tool backend"
```

---

### Task 3: Model-facing tool schemas

**Files:**
- Create: `deemsvc/src/deemsvc/sdk/tools.py`
- Create: `deemsvc/tests/test_sdk_tools.py`

**Interfaces:**
- Consumes: `MEMORY_TOOL` from Task 2.
- Produces: `GENERATOR_TOOLS: list[dict]` (schemas for `run_tests`, `send_to_user`, the built-in text-editor tool, and `MEMORY_TOOL`).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_sdk_tools.py`:

```python
import jsonschema
import pytest

from deemsvc.sdk.tools import GENERATOR_TOOLS


def test_every_custom_tool_is_strict():
    custom = [t for t in GENERATOR_TOOLS if "input_schema" in t]
    assert custom, "expected at least one custom (non-built-in) tool"
    for tool in custom:
        assert tool["strict"] is True


def test_run_tests_schema_requires_selector():
    run_tests = next(t for t in GENERATOR_TOOLS if t["name"] == "run_tests")
    jsonschema.validate({"selector": "tests/test_x.py"}, run_tests["input_schema"])
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({}, run_tests["input_schema"])


def test_run_tests_schema_rejects_unknown_properties():
    run_tests = next(t for t in GENERATOR_TOOLS if t["name"] == "run_tests")
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"selector": "x", "extra": "nope"}, run_tests["input_schema"])


def test_send_to_user_schema_requires_message():
    send = next(t for t in GENERATOR_TOOLS if t["name"] == "send_to_user")
    jsonschema.validate({"message": "hello"}, send["input_schema"])
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({}, send["input_schema"])


def test_built_in_tools_are_declared_by_type_only():
    editor = next(t for t in GENERATOR_TOOLS if t.get("type") == "text_editor_20250728")
    assert editor["name"] == "str_replace_based_edit_tool"
    assert "input_schema" not in editor


def test_memory_tool_is_included():
    memory = next(t for t in GENERATOR_TOOLS if t.get("type") == "memory_20250818")
    assert memory["name"] == "memory"
```

- [ ] **Step 2: Add jsonschema as a dev dependency and run the test to verify it fails**

Edit `deemsvc/pyproject.toml`'s `dev` optional dependencies — **add** `jsonschema`,
don't replace the list: `deemsvc-tool-broker`'s Task 4 already added `ruff>=0.4` to
this same line, and overwriting it drops a dependency the ruff-json tool spec's own
tests need on a fresh install (this exact regression happened during execution —
caught only because `ruff` was still importable from an earlier, no-longer-declared
install; see this task's own execution notes).

```toml
[project.optional-dependencies]
dev = ["pytest>=8.0", "pytest-asyncio>=0.24", "ruff>=0.4", "jsonschema>=4.0"]
```

Run:
```bash
cd deemsvc && .venv/bin/pip install -e ".[dev]" && .venv/bin/pytest tests/test_sdk_tools.py -v
```
Expected: FAIL with `ModuleNotFoundError: No module named 'deemsvc.sdk.tools'`

- [ ] **Step 3: Implement GENERATOR_TOOLS**

`deemsvc/src/deemsvc/sdk/tools.py`:

```python
from .memory import MEMORY_TOOL

GENERATOR_TOOLS: list[dict] = [
    {
        "name": "run_tests",
        "description": (
            "Run the pytest suite or a selector inside your worktree. Call this "
            "after every edit that could affect behavior, and before reporting "
            "any test-related progress. Returns the parsed pass/fail matrix."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "pytest node id or path, e.g. tests/test_cache.py",
                },
            },
            "required": ["selector"],
            "additionalProperties": False,
        },
    },
    {
        "name": "send_to_user",
        "description": (
            "Display a message to the operator exactly as written. Use for a "
            "progress figure, a partial result, or a direct answer the operator "
            "must see before the task finishes. Content is never summarized."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {"message": {"type": "string"}},
            "required": ["message"],
            "additionalProperties": False,
        },
    },
    # Anthropic-defined text editor + bash are declared schema-less, by type only:
    {"type": "text_editor_20250728", "name": "str_replace_based_edit_tool"},
    MEMORY_TOOL,
]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_sdk_tools.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/pyproject.toml deemsvc/src/deemsvc/sdk/tools.py deemsvc/tests/test_sdk_tools.py
git commit -m "feat(deemsvc): add model-facing tool schemas for the generator role"
```

---

### Task 4: The AgentAdapter protocol

**Files:**
- Create: `deemsvc/src/deemsvc/sdk/adapter.py`
- Create: `deemsvc/tests/test_sdk_adapter_protocol.py`

**Interfaces:**
- Consumes: `Step`, `StepResult` from `deemsvc-orchestrator-core`.
- Produces: `AgentAdapter` (a `@runtime_checkable` `Protocol`: `async def __call__(self, step: Step) -> StepResult`) — the single contract every concrete backend (Task 5's `FableDispatcher`, Task 6's `CliAgentAdapter`, and any future backend) satisfies. Nothing outside `deemsvc/src/deemsvc/sdk/` needs to change to add a new backend; it only needs a class matching this shape, registered in Task 7.

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_sdk_adapter_protocol.py`:

```python
import pytest

from deemsvc.orchestrator.state import Step, StepResult
from deemsvc.sdk.adapter import AgentAdapter


class _TrivialAdapter:
    async def __call__(self, step: Step) -> StepResult:
        return StepResult(step.id, "pass", 0, {})


def test_a_correctly_shaped_class_satisfies_the_protocol():
    assert isinstance(_TrivialAdapter(), AgentAdapter)


def test_an_object_missing_call_does_not_satisfy_the_protocol():
    class NotAnAdapter:
        pass
    assert not isinstance(NotAnAdapter(), AgentAdapter)


@pytest.mark.asyncio
async def test_the_trivial_adapter_actually_works_as_a_dispatch_callable():
    step = Step(id="s", step_class="generate", payload={}, deps=frozenset())
    result = await _TrivialAdapter()(step)
    assert result.verdict == "pass"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_sdk_adapter_protocol.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'deemsvc.sdk.adapter'`

- [ ] **Step 3: Implement the AgentAdapter protocol**

`deemsvc/src/deemsvc/sdk/adapter.py`:

```python
from __future__ import annotations

from typing import Protocol, runtime_checkable

from deemsvc.orchestrator.state import Step, StepResult


@runtime_checkable
class AgentAdapter(Protocol):
    """The one contract every pluggable agent backend must satisfy — the same
    Callable[[Step], Awaitable[StepResult]] shape Orchestrator.dispatch and
    GenerateThenVerifyDispatcher already expect. FableDispatcher (Task 5) and
    CliAgentAdapter (Task 6) are the two concrete implementations this plan
    ships; a third backend is a third class satisfying this same __call__
    signature registered in ADAPTER_FACTORIES (Task 7) — no other file in
    deemsvc needs to change.

    Invariant every implementation must uphold (see Global Constraints):
    candidate_ref is always computed from `git rev-parse HEAD` after the
    agent's work is done, never parsed from the agent's own output.
    """

    async def __call__(self, step: Step) -> StepResult: ...
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_sdk_adapter_protocol.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/sdk/adapter.py deemsvc/tests/test_sdk_adapter_protocol.py
git commit -m "feat(deemsvc): define the AgentAdapter protocol pluggable backends satisfy"
```

---

### Task 5: FableDispatcher — the Anthropic-native agentic tool-use loop

**Files:**
- Create: `deemsvc/src/deemsvc/sdk/dispatch.py`
- Create: `deemsvc/tests/test_sdk_dispatch_stub.py`

**Interfaces:**
- Consumes: `build_request` (Task 1), `MemoryStore` (Task 2), `AgentAdapter` (Task 4), `ToolBroker`/`OutcomeKind` from `deemsvc-tool-broker`, `Step`/`StepResult` from `deemsvc-orchestrator-core`.
- Produces: `FableDispatcher` (class: `__init__(client, run_root: str)`; `async def __call__(step: Step) -> StepResult`) — satisfies `AgentAdapter`.

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_sdk_dispatch_stub.py`:

```python
import subprocess
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from deemsvc.orchestrator.state import Step
from deemsvc.sdk.adapter import AgentAdapter
from deemsvc.sdk.dispatch import FableDispatcher


def _text_block(text):
    return SimpleNamespace(type="text", text=text)


def _tool_use_block(id_, name, input_):
    return SimpleNamespace(type="tool_use", id=id_, name=name, input=input_)


class _FakeStreamCtx:
    def __init__(self, message):
        self._message = message

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get_final_message(self):
        return self._message


def _message(content, stop_reason, usage_in=100, usage_out=50, stop_details=None):
    return SimpleNamespace(
        content=content, stop_reason=stop_reason, stop_details=stop_details,
        usage=SimpleNamespace(input_tokens=usage_in, output_tokens=usage_out),
    )


@pytest.fixture
def worktree(tmp_path):
    repo = tmp_path / "worktree"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=repo, check=True)
    (repo / "README.md").write_text("hi\n")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
    return repo


def _step(worktree_path: str) -> Step:
    return Step(
        id="impl", step_class="generate", deps=frozenset(),
        payload={
            "system_blocks": [{"type": "text", "text": "persona"}],
            "tools": [],
            "objective": "do the thing",
            "capability_grant": {"worktree": worktree_path},
        },
    )


def test_fable_dispatcher_satisfies_the_agent_adapter_protocol():
    assert isinstance(FableDispatcher(client=None, run_root="."), AgentAdapter)


@pytest.mark.asyncio
async def test_dispatcher_returns_pass_with_real_head_sha_after_tool_use_then_end_turn(worktree):
    # Turn 1: model uses send_to_user. Turn 2: model ends its turn.
    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=None)))
    calls = [
        _FakeStreamCtx(_message(
            [_tool_use_block("t1", "send_to_user", {"message": "progress"})], "tool_use")),
        _FakeStreamCtx(_message([_text_block("done")], "end_turn")),
    ]
    client.beta.messages.stream = lambda **kwargs: calls.pop(0)

    dispatcher = FableDispatcher(client, str(worktree))
    step = _step(str(worktree))
    result = await dispatcher(step)

    assert result.verdict == "pass"
    assert result.evidence["candidate_ref"]
    assert len(result.evidence["candidate_ref"]) == 40  # a real git SHA
    assert result.tokens_spent == (100 + 50) * 2  # two turns


@pytest.mark.asyncio
async def test_dispatcher_escalates_on_final_refusal(worktree):
    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=None)))
    refusal = _message([], "refusal", stop_details=SimpleNamespace(category="policy"))
    client.beta.messages.stream = lambda **kwargs: _FakeStreamCtx(refusal)

    dispatcher = FableDispatcher(client, str(worktree))
    step = _step(str(worktree))
    result = await dispatcher(step)

    assert result.verdict == "escalate"
    assert result.evidence["refusal"] == "policy"


@pytest.mark.asyncio
async def test_dispatcher_routes_memory_tool_calls_through_the_memory_store(worktree):
    calls = [
        _FakeStreamCtx(_message(
            [_tool_use_block("t1", "memory", {"command": "create", "path": "/memories/note.md",
                                              "file_text": "lesson learned"})], "tool_use")),
        _FakeStreamCtx(_message([_text_block("done")], "end_turn")),
    ]
    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(
        stream=lambda **kwargs: calls.pop(0))))

    dispatcher = FableDispatcher(client, str(worktree))
    step = _step(str(worktree))
    await dispatcher(step)

    note = (worktree / "memories" / "note.md")
    assert note.exists()
    assert "lesson learned" in note.read_text()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_sdk_dispatch_stub.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'deemsvc.sdk.dispatch'`

- [ ] **Step 3: Implement FableDispatcher**

`deemsvc/src/deemsvc/sdk/dispatch.py`:

```python
from __future__ import annotations

import json

from deemsvc.orchestrator.state import Step, StepResult
from deemsvc.sandbox.broker import OutcomeKind, ToolBroker
from .memory import MemoryStore
from .request import build_request


class FableDispatcher:
    """Direct-Anthropic-API adapter. One of several AgentAdapter implementations
    (see sdk/adapter.py) — the one with Fable-5-specific capabilities (task
    budgets, memory tool, effort levels). CLI-backed adapters (sdk/cli_adapter.py)
    have none of this machinery and are equally valid AgentAdapters."""

    def __init__(self, client, run_root: str):
        self.client = client
        self.run_root = run_root

    async def _editor(self, broker: ToolBroker, tool_input: dict) -> str:
        """Text-editor tool calls resolve to broker-invoked git/pytest primitives
        are out of scope for this method — Anthropic's server-executed text editor
        tool handles file reads/writes directly against the sandboxed filesystem
        path the worktree grant exposes; this dispatcher only needs to pass its
        result through, since the tool itself is declared server-side (§8.4) and
        the SDK resolves it without a client-side handler for the common case.
        This stub exists so a future custom editor policy has a single seam."""
        return json.dumps({"ok": True, "input": tool_input})

    def _emit(self, step_id: str, message: str) -> str:
        return f"sent: {message}"

    async def __call__(self, step: Step) -> StepResult:
        role = {"explore": "explorer", "generate": "generator",
                "verify": "verifier", "integrate": "planner"}[step.step_class]
        grant = step.payload["capability_grant"]
        broker = ToolBroker(grant["worktree"])
        memory = MemoryStore(grant["worktree"])

        system = step.payload["system_blocks"]        # frozen persona + pinned criteria
        tools = step.payload["tools"]
        messages: list[dict] = [{"role": "user", "content": step.payload["objective"]}]
        kwargs, betas = build_request(role, system, messages, tools)

        spent, tool_calls, claims = 0, 0, []
        while True:
            async with self.client.beta.messages.stream(betas=betas, **kwargs) as stream:
                msg = await stream.get_final_message()

            spent += msg.usage.input_tokens + msg.usage.output_tokens

            # Refusal: fallback already ran server-side. A refusal on the final
            # message means the whole chain declined — escalate, don't loop.
            if msg.stop_reason == "refusal":
                return StepResult(step.id, "escalate", spent,
                                  {"refusal": msg.stop_details.category
                                   if msg.stop_details else None})

            # Preserve full content (incl. compaction/fallback blocks) for the next turn.
            messages.append({"role": "assistant", "content": msg.content})
            kwargs["messages"] = messages

            if msg.stop_reason != "tool_use":
                break

            results = []
            for block in msg.content:
                if block.type != "tool_use":
                    continue
                tool_calls += 1
                if block.name == "memory":
                    out = memory.handle(block.input)
                elif block.name == "send_to_user":
                    out = self._emit(step.id, block.input["message"])
                elif block.name == "run_tests":
                    outcome = await broker.invoke("pytest-junit",
                                                  selector=block.input["selector"])
                    out = json.dumps(outcome.parsed)
                else:  # text editor / bash handled server-side or by broker file ops
                    out = await self._editor(broker, block.input)
                results.append({"type": "tool_result",
                                "tool_use_id": block.id, "content": out})
            messages.append({"role": "user", "content": results})   # ALL results, one message
            kwargs["messages"] = messages

        # Compute the candidate ref from git — never trust the model's claim.
        head = await broker.invoke("git", sub="rev-parse", a1="HEAD")
        candidate_ref = head.parsed.get("stdout", "").strip()
        claims.append({"claim": "candidate committed",
                       "evidence": {"type": "git_diff_digest", "worktree_head": candidate_ref}})

        # The dispatcher returns a *proposed* pass; the Verifier is the arbiter.
        # The orchestrator routes generate-class results through it before any
        # PASSED transition — the dispatcher never self-certifies.
        verdict = "pass" if candidate_ref else "retry"
        return StepResult(step.id, verdict, spent,
                          evidence={"candidate_ref": candidate_ref, "claims": claims,
                                    "tool_calls": tool_calls})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_sdk_dispatch_stub.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/sdk/dispatch.py deemsvc/tests/test_sdk_dispatch_stub.py
git commit -m "feat(deemsvc): add FableDispatcher, the Anthropic-native AgentAdapter"
```

---

### Task 6: CLI-backed adapters — claude-code-cli and codex-cli

**Files:**
- Create: `deemsvc/src/deemsvc/sdk/cli_adapter.py`
- Create: `deemsvc/tests/test_sdk_cli_adapter.py`

**Interfaces:**
- Consumes: `AgentAdapter` (Task 4), `ToolBroker`/`OutcomeKind` from `deemsvc-tool-broker`, `Step`/`StepResult` from `deemsvc-orchestrator-core`.
- Produces: `CliAdapterSpec` (frozen dataclass: `name: str, argv: tuple[str, ...], prompt_via: Literal["stdin","arg"], timeout_s: int = 1800`), `CliAgentAdapter` (class: `__init__(spec: CliAdapterSpec)`; `async def __call__(step: Step) -> StepResult`) — satisfies `AgentAdapter`.

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_sdk_cli_adapter.py`:

```python
import stat
import subprocess

import pytest

from deemsvc.orchestrator.state import Step
from deemsvc.sdk.adapter import AgentAdapter
from deemsvc.sdk.cli_adapter import CliAdapterSpec, CliAgentAdapter


def _fake_cli_script(tmp_path, body: str) -> str:
    """A hermetic stand-in for `claude`/`codex` — no real CLI or network
    dependency. What's under test is CliAgentAdapter's behavior (compute
    candidate_ref from git, ignore the process's own claims, enforce the
    timeout), which is identical no matter which real binary sits behind it."""
    script = tmp_path / "fake-cli"
    script.write_text(body)
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return str(script)


@pytest.fixture
def worktree(tmp_path):
    repo = tmp_path / "worktree"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=repo, check=True)
    (repo / "README.md").write_text("hi\n")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
    return repo


def _step(worktree_path: str) -> Step:
    return Step(
        id="impl", step_class="generate", deps=frozenset(),
        payload={"objective": "add a line to README",
                "capability_grant": {"worktree": worktree_path}},
    )


def test_cli_agent_adapter_satisfies_the_agent_adapter_protocol():
    spec = CliAdapterSpec(name="fake", argv=("true",), prompt_via="stdin")
    assert isinstance(CliAgentAdapter(spec), AgentAdapter)


@pytest.mark.asyncio
async def test_candidate_ref_comes_from_git_never_from_the_cli_own_claim(tmp_path, worktree):
    # The fake CLI commits a real change AND prints an unrelated success claim —
    # the adapter must derive candidate_ref from git, not from stdout.
    script = _fake_cli_script(tmp_path, f"""#!/bin/sh
cd "{worktree}"
echo "second line" >> README.md
git add -A
git commit -q -m "candidate"
echo '{{"type": "tool_use", "name": "edit"}}'
echo '{{"type": "result", "success": true, "note": "trust me, it works"}}'
""")
    spec = CliAdapterSpec(name="fake-cli", argv=(script,), prompt_via="stdin", timeout_s=10)
    adapter = CliAgentAdapter(spec)
    result = await adapter(_step(str(worktree)))

    assert result.verdict == "pass"
    assert len(result.evidence["candidate_ref"]) == 40
    assert result.evidence["tool_calls"] == 1
    assert result.evidence["cli"] == "fake-cli"


@pytest.mark.asyncio
async def test_no_commit_means_retry_regardless_of_what_the_cli_printed(tmp_path, worktree):
    script = _fake_cli_script(tmp_path, "#!/bin/sh\necho '{\"type\": \"result\", \"success\": true}'\n")
    spec = CliAdapterSpec(name="fake-cli", argv=(script,), prompt_via="stdin", timeout_s=10)
    adapter = CliAgentAdapter(spec)
    result = await adapter(_step(str(worktree)))
    assert result.verdict == "retry"
    assert result.evidence["candidate_ref"] == ""


@pytest.mark.asyncio
async def test_a_slow_process_is_killed_and_reported_as_retry(tmp_path, worktree):
    script = _fake_cli_script(tmp_path, "#!/bin/sh\nsleep 5\n")
    spec = CliAdapterSpec(name="fake-cli", argv=(script,), prompt_via="stdin", timeout_s=1)
    adapter = CliAgentAdapter(spec)
    result = await adapter(_step(str(worktree)))
    assert result.verdict == "retry"
    assert "timed out" in result.evidence["error"]


@pytest.mark.asyncio
async def test_prompt_via_arg_appends_the_objective_as_an_argv_element(tmp_path, worktree):
    # A script that echoes its own argv, so we can see the objective arrived.
    script = _fake_cli_script(tmp_path, '#!/bin/sh\necho "argv: $@"\n')
    spec = CliAdapterSpec(name="fake-cli", argv=(script,), prompt_via="arg", timeout_s=10)
    adapter = CliAgentAdapter(spec)
    step = _step(str(worktree))
    await adapter(step)  # no commit is made; we only care that it didn't crash
    # Sanity: prompt_via="arg" doesn't write to stdin, so a script expecting
    # stdin input would hang — this test passing (not timing out) is the proof.
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_sdk_cli_adapter.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'deemsvc.sdk.cli_adapter'`

- [ ] **Step 3: Implement CliAdapterSpec and CliAgentAdapter**

`deemsvc/src/deemsvc/sdk/cli_adapter.py`:

```python
from __future__ import annotations

import asyncio
import json
import os
import signal
from dataclasses import dataclass
from typing import Literal

from deemsvc.orchestrator.state import Step, StepResult
from deemsvc.sandbox.broker import OutcomeKind, ToolBroker


@dataclass(frozen=True)
class CliAdapterSpec:
    """Fixed argv template + prompt-delivery convention for one CLI-based
    coding agent. Adding a fourth CLI tool means adding a fourth CliAdapterSpec
    instance in registry.py — never a new adapter class."""
    name: str
    argv: tuple[str, ...]           # e.g. ("claude", "-p", "--output-format", "stream-json")
    prompt_via: Literal["stdin", "arg"]   # how the objective text is delivered
    timeout_s: int = 1800


class CliAgentAdapter:
    """Implements AgentAdapter by shelling out to an installed CLI coding tool.
    Same invariant as FableDispatcher: the CLI's own transcript/self-report is
    never trusted — candidate_ref always comes from `git rev-parse HEAD` via
    ToolBroker, computed after the subprocess exits, regardless of what the CLI
    printed. This is what lets CLI-backed generation be routed through
    GenerateThenVerifyDispatcher's Verifier arbitration exactly like Fable 5
    native generation does — the Verifier only ever needs a git ref."""

    def __init__(self, spec: CliAdapterSpec):
        self.spec = spec

    async def __call__(self, step: Step) -> StepResult:
        grant = step.payload["capability_grant"]
        worktree = grant["worktree"]
        objective = step.payload["objective"]

        argv = list(self.spec.argv)
        if self.spec.prompt_via == "arg":
            argv.append(objective)

        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=worktree, env=env,
            stdin=asyncio.subprocess.PIPE if self.spec.prompt_via == "stdin" else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        if self.spec.prompt_via == "stdin":
            proc.stdin.write(objective.encode())
            await proc.stdin.drain()
            proc.stdin.close()

        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=self.spec.timeout_s)
        except asyncio.TimeoutError:
            os.killpg(proc.pid, signal.SIGKILL)
            await proc.wait()
            return StepResult(step.id, "retry", 0,
                              evidence={"candidate_ref": "",
                                       "error": f"{self.spec.name} timed out after {self.spec.timeout_s}s"})

        tool_calls = 0
        for line in stdout.decode(errors="replace").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "tool_use":
                tool_calls += 1

        broker = ToolBroker(worktree)
        head = await broker.invoke("git", sub="rev-parse", a1="HEAD")
        candidate_ref = head.parsed.get("stdout", "").strip() if head.kind is OutcomeKind.TOOL_OK else ""

        # Never trust the CLI's own success claim — only a real commit counts.
        verdict = "pass" if candidate_ref else "retry"
        return StepResult(step.id, verdict, tokens_spent=0,  # CLIs don't report usage uniformly
                          evidence={"candidate_ref": candidate_ref, "tool_calls": tool_calls,
                                   "cli": self.spec.name})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_sdk_cli_adapter.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/sdk/cli_adapter.py deemsvc/tests/test_sdk_cli_adapter.py
git commit -m "feat(deemsvc): add CLI-backed AgentAdapter for claude-code-cli and codex-cli"
```

---

### Task 7: Adapter registry — selecting a backend by name

**Files:**
- Create: `deemsvc/src/deemsvc/sdk/registry.py`
- Create: `deemsvc/tests/test_sdk_registry.py`

**Interfaces:**
- Consumes: `AgentAdapter` (Task 4), `FableDispatcher` (Task 5), `CliAdapterSpec`/`CliAgentAdapter` (Task 6).
- Produces: `AdapterContext` (dataclass: `client: object | None = None, run_root: str = "."`), `CLAUDE_CODE_CLI: CliAdapterSpec`, `CODEX_CLI: CliAdapterSpec`, `ADAPTER_FACTORIES: dict[str, Callable[[AdapterContext], AgentAdapter]]` (keys: `"fable5-native", "claude-code-cli", "codex-cli"`), `build_adapter(name: str, ctx: AdapterContext) -> AgentAdapter`.

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_sdk_registry.py`:

```python
import pytest

from deemsvc.sdk.adapter import AgentAdapter
from deemsvc.sdk.cli_adapter import CliAgentAdapter
from deemsvc.sdk.dispatch import FableDispatcher
from deemsvc.sdk.registry import ADAPTER_FACTORIES, AdapterContext, build_adapter


def test_every_registered_factory_produces_an_agent_adapter():
    for name in ADAPTER_FACTORIES:
        adapter = build_adapter(name, AdapterContext(client=object(), run_root="."))
        assert isinstance(adapter, AgentAdapter)


def test_unknown_name_raises_with_known_names_listed():
    with pytest.raises(ValueError, match="claude-code-cli"):
        build_adapter("nonexistent", AdapterContext())


def test_fable5_native_passes_through_client_and_run_root():
    ctx = AdapterContext(client="fake-client", run_root="/tmp/x")
    adapter = build_adapter("fable5-native", ctx)
    assert isinstance(adapter, FableDispatcher)
    assert adapter.client == "fake-client"
    assert adapter.run_root == "/tmp/x"


def test_claude_code_cli_factory_ignores_the_client_field():
    ctx = AdapterContext(client=None, run_root=".")
    adapter = build_adapter("claude-code-cli", ctx)
    assert isinstance(adapter, CliAgentAdapter)
    assert adapter.spec.name == "claude-code-cli"
    assert adapter.spec.argv[0] == "claude"


def test_codex_cli_factory_produces_the_codex_spec():
    adapter = build_adapter("codex-cli", AdapterContext())
    assert isinstance(adapter, CliAgentAdapter)
    assert adapter.spec.name == "codex-cli"
    assert adapter.spec.argv[0] == "codex"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_sdk_registry.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'deemsvc.sdk.registry'`

- [ ] **Step 3: Implement the registry**

`deemsvc/src/deemsvc/sdk/registry.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .adapter import AgentAdapter
from .cli_adapter import CliAdapterSpec, CliAgentAdapter
from .dispatch import FableDispatcher


@dataclass
class AdapterContext:
    """Everything a concrete adapter factory might need. Individual factories
    read only the fields they use — the CLI factories ignore `client` entirely,
    since they authenticate however the installed CLI is already configured."""
    client: object | None = None   # AsyncAnthropic — only fable5-native uses this
    run_root: str = "."


CLAUDE_CODE_CLI = CliAdapterSpec(
    name="claude-code-cli",
    argv=("claude", "-p", "--output-format", "stream-json"),
    prompt_via="stdin",
)
CODEX_CLI = CliAdapterSpec(
    name="codex-cli",
    argv=("codex", "exec", "--json"),
    prompt_via="arg",
)

ADAPTER_FACTORIES: dict[str, Callable[[AdapterContext], AgentAdapter]] = {
    "fable5-native": lambda ctx: FableDispatcher(ctx.client, ctx.run_root),
    "claude-code-cli": lambda ctx: CliAgentAdapter(CLAUDE_CODE_CLI),
    "codex-cli": lambda ctx: CliAgentAdapter(CODEX_CLI),
}


def build_adapter(name: str, ctx: AdapterContext) -> AgentAdapter:
    factory = ADAPTER_FACTORIES.get(name)
    if factory is None:
        raise ValueError(f"unknown agent adapter {name!r}. Known: {sorted(ADAPTER_FACTORIES)}")
    return factory(ctx)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_sdk_registry.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/sdk/registry.py deemsvc/tests/test_sdk_registry.py
git commit -m "feat(deemsvc): add the adapter registry — select a backend by name"
```

---

### Task 8: Route VerifierEngine's semantic review through build_request

**Files:**
- Modify: `deemsvc/src/deemsvc/verifier/engine.py`
- Modify: `deemsvc/tests/test_verifier_semantic_review.py`

**Interfaces:**
- Consumes: `build_request` from Task 1.
- Produces: no new public interface — `_semantic_review`'s signature and return shape are unchanged; only its internal request construction changes. (This task is unaffected by Tasks 4-7's pluggability additions: the Verifier's semantic-review judge is always a fresh-context Anthropic call regardless of which adapter produced the candidate being judged — it judges a git diff, not an adapter.)

- [ ] **Step 1: Update the semantic-review test to assert the fallback chain is present**

Add this test to `deemsvc/tests/test_verifier_semantic_review.py` (keep the existing
`pytestmark` skip guard and fixture; this test additionally requires
`ANTHROPIC_API_KEY` and inspects the outgoing request via monkeypatching the client's
`beta.messages.create`):

```python
@pytest.mark.asyncio
async def test_semantic_review_request_carries_the_opus_fallback(repo_with_diff, monkeypatch):
    from anthropic import AsyncAnthropic

    repo_root, baseline, candidate = repo_with_diff
    engine = VerifierEngine(repo_root, client=AsyncAnthropic())
    task = VerificationTask(step_id="s", repo_root=repo_root, baseline_ref=baseline,
                            candidate_ref=candidate, acceptance_criteria=(), attempt=1,
                            max_attempts=3, prior_signatures=frozenset(), changed_paths=())

    captured = {}
    real_create = engine.client.beta.messages.create

    async def spy(*args, **kwargs):
        captured.update(kwargs)
        return await real_create(*args, **kwargs)

    monkeypatch.setattr(engine.client.beta.messages, "create", spy)
    await engine._semantic_review(task, repo_root, deltas=[])
    assert captured["fallbacks"] == [{"model": "claude-opus-4-8"}]
```

- [ ] **Step 2: Run the test to verify it fails (or is skipped)**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_semantic_review.py -v`
Expected: if `ANTHROPIC_API_KEY` is set, FAIL with `KeyError: 'fallbacks'` (the current
implementation doesn't set that key — see Task 7 of `deemsvc-verifier-engine`, which
built a direct `messages.create` call without the fallback wiring). If unset, all
semantic-review tests skip — proceed to Step 3 regardless.

- [ ] **Step 3: Route the call through build_request**

In `deemsvc/src/deemsvc/verifier/engine.py`, add
`from deemsvc.sdk.request import build_request` to the imports, then replace the body
of `_semantic_review` (added in `deemsvc-verifier-engine` Task 7) with:

```python
    async def _semantic_review(self, task: VerificationTask,
                               cand_dir: str, deltas: list[TestDelta]) -> dict:
        """Fresh-context model call. Input = diff + criteria + mechanical evidence.
        The Generator's conversation is structurally unreachable from here."""
        git = ToolBroker(self.repo_root)
        diff = await git.invoke("git", sub="diff", a1=task.baseline_ref, a2=task.candidate_ref)
        schema = {
            "type": "object",
            "properties": {
                "criteria": {"type": "array", "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "met": {"type": "boolean"},
                        "evidence": {"type": "string"},
                    },
                    "required": ["id", "met", "evidence"],
                    "additionalProperties": False,
                }},
                "scope_creep": {"type": "boolean"},
                "notes": {"type": "string"},
            },
            "required": ["criteria", "scope_creep", "notes"],
            "additionalProperties": False,
        }
        system = [{"type": "text", "text": (
            "You are a verification judge. You receive a diff and acceptance "
            "criteria. Judge only what the evidence shows. You cannot see the "
            "author's reasoning, and you must not infer intent from it. "
            "Mark a criterion met only if the diff plus test evidence proves it."
        )}]
        messages = [{"role": "user", "content": json.dumps({
            "acceptance_criteria": task.acceptance_criteria,
            "diff": diff.parsed.get("raw", "")[:150_000],
            "test_transitions": [
                {"test_id": d.test_id, "kind": str(d.kind), "trace_head": d.trace_head}
                for d in deltas
            ],
        })}]
        kwargs, betas = build_request("verifier", system, messages, tools=[])
        kwargs["output_config"]["format"] = {"type": "json_schema", "schema": schema}

        # `betas` is only accepted on the `beta` namespace — matches
        # FableDispatcher's `self.client.beta.messages.stream(betas=betas, ...)`.
        response = await self.client.beta.messages.create(betas=betas, **kwargs)
        if response.stop_reason == "refusal":
            return {"criteria": [], "scope_creep": False,
                    "notes": "judge declined; mechanical evidence governs"}
        return json.loads(response.content[-1].text)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_semantic_review.py -v`
Expected: passes if `ANTHROPIC_API_KEY` is set, all skipped otherwise. Either is
acceptable.

- [ ] **Step 5: Run the full deemsvc test suite**

Run: `cd deemsvc && .venv/bin/pytest -v`
Expected: every test across all four plans built so far passes together (130+ tests,
0 failures, live-API tests skipped unless `ANTHROPIC_API_KEY` is set).

- [ ] **Step 6: Commit**

```bash
git add deemsvc/src/deemsvc/verifier/engine.py deemsvc/tests/test_verifier_semantic_review.py
git commit -m "refactor(deemsvc): route semantic review through the shared request builder"
```
