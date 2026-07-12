# deemsvc Orchestrator Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic orchestration core of `deemsvc` — the typed step
state machine, hierarchical token budget, frontier scheduler, and write-ahead JSONL
journal — as a standalone, fully tested Python package with zero LLM/network calls.

**Architecture:** A single `Orchestrator` runs an `asyncio` event loop over a DAG of
`Step` objects, dispatching the ready frontier through an injected `dispatch` callable
and recording every legal state transition to a journal before it takes effect. This
plan uses a scripted stub dispatcher so the state machine, budget accounting, and
crash-recovery logic can be proven correct before any agent or sandbox code exists.

**Tech Stack:** Python 3.11+, `asyncio`, `pytest`, `pytest-asyncio`. No third-party
runtime dependencies in this package.

## Global Constraints

- Python 3.11+ (the state machine uses `enum.StrEnum`, added in 3.11).
- New top-level directory `deemsvc/` at the repo root, sibling to `server/` and `web/`.
- Src layout: source under `deemsvc/src/deemsvc/`, tests under `deemsvc/tests/`.
- Test runner: `pytest` with `pytest-asyncio` (`asyncio_mode = "auto"`).
- No network calls anywhere in this plan — the dispatch callable is a deterministic
  in-memory stub. Real LLM/tool dispatch is built in later plans and plugged into
  the same `Orchestrator` interface unchanged.
- Journal format: JSON Lines, one record per line, keys sorted, flushed and fsync'd
  on every append (per `docs/specs/2026-07-12-fable5-engine-rebuild-design.md` §4:
  "journal is source of truth").
- Source reference: `docs/AI-CODING-AGENT-ARCHITECTURAL-BLUEPRINT.md` §3 (the
  `orchestrator/state.py` reference implementation this plan adapts).

---

### Task 1: Package scaffold + step status transition table

**Files:**
- Create: `deemsvc/pyproject.toml`
- Create: `deemsvc/src/deemsvc/__init__.py`
- Create: `deemsvc/src/deemsvc/orchestrator/__init__.py`
- Create: `deemsvc/src/deemsvc/orchestrator/state.py`
- Create: `deemsvc/tests/__init__.py`
- Create: `deemsvc/tests/test_state_transitions.py`

**Interfaces:**
- Produces: `StepStatus` (StrEnum: `BLOCKED, READY, DISPATCHED, EXECUTING, VERIFYING, PASSED, RETRYING, ESCALATED, ABANDONED`), `IllegalTransition(RuntimeError)`, a module-level `_LEGAL: dict[StepStatus, frozenset[StepStatus]]` transition table.

- [ ] **Step 1: Create the package scaffold**

`deemsvc/pyproject.toml`:

```toml
[project]
name = "deemsvc"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = []

[project.optional-dependencies]
dev = ["pytest>=8.0", "pytest-asyncio>=0.24"]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"

[build-system]
requires = ["setuptools>=68", "wheel"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]
```

`deemsvc/src/deemsvc/__init__.py`: empty file.

`deemsvc/src/deemsvc/orchestrator/__init__.py`: empty file.

`deemsvc/tests/__init__.py`: empty file.

- [ ] **Step 2: Install the package in editable mode**

Run:
```bash
cd deemsvc && python3.11 -m venv .venv && .venv/bin/pip install -e ".[dev]"
```
Expected: installs cleanly, `.venv/bin/pytest --version` prints a pytest version.

- [ ] **Step 3: Write the failing test for the transition table**

`deemsvc/tests/test_state_transitions.py`:

```python
from deemsvc.orchestrator.state import StepStatus, _LEGAL


def test_every_status_has_a_table_entry():
    assert set(_LEGAL.keys()) == set(StepStatus)


def test_blocked_can_go_ready_or_abandoned_only():
    assert _LEGAL[StepStatus.BLOCKED] == frozenset({StepStatus.READY, StepStatus.ABANDONED})


def test_terminal_states_have_no_outbound_edges():
    assert _LEGAL[StepStatus.PASSED] == frozenset()
    assert _LEGAL[StepStatus.ABANDONED] == frozenset()


def test_verifying_to_retrying_is_the_only_route_back_to_generation():
    # VERIFYING -> RETRYING exists; nothing else transitions directly into RETRYING
    # except via VERIFYING (retry is always a verifier adjudication, never self-initiated).
    sources_of_retrying = [s for s, targets in _LEGAL.items() if StepStatus.RETRYING in targets]
    assert sources_of_retrying == [StepStatus.VERIFYING]


def test_escalated_to_ready_is_the_only_reentry_point():
    sources_of_ready = [s for s, targets in _LEGAL.items() if StepStatus.READY in targets]
    assert set(sources_of_ready) == {StepStatus.BLOCKED, StepStatus.ESCALATED}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_state_transitions.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'deemsvc.orchestrator.state'`

- [ ] **Step 5: Implement the transition table**

`deemsvc/src/deemsvc/orchestrator/state.py`:

```python
from __future__ import annotations

from enum import StrEnum


class StepStatus(StrEnum):
    BLOCKED = "blocked"        # dependencies unmet
    READY = "ready"            # frontier member, awaiting budget + slot
    DISPATCHED = "dispatched"  # task.assign emitted, awaiting ack
    EXECUTING = "executing"    # sub-agent heartbeating
    VERIFYING = "verifying"    # Stage-3 pipeline engaged
    PASSED = "passed"          # verifier verdict committed (terminal-success)
    RETRYING = "retrying"      # verifier returned retry + feedback packet
    ESCALATED = "escalated"    # requires human or orchestrator-level replan
    ABANDONED = "abandoned"    # cascaded cancellation (terminal-failure)


_LEGAL: dict[StepStatus, frozenset[StepStatus]] = {
    StepStatus.BLOCKED:    frozenset({StepStatus.READY, StepStatus.ABANDONED}),
    StepStatus.READY:      frozenset({StepStatus.DISPATCHED, StepStatus.ABANDONED}),
    StepStatus.DISPATCHED: frozenset({StepStatus.EXECUTING, StepStatus.ESCALATED,
                                      StepStatus.ABANDONED}),
    StepStatus.EXECUTING:  frozenset({StepStatus.VERIFYING, StepStatus.RETRYING,
                                      StepStatus.ESCALATED, StepStatus.ABANDONED}),
    StepStatus.VERIFYING:  frozenset({StepStatus.PASSED, StepStatus.RETRYING,
                                      StepStatus.ESCALATED}),
    StepStatus.RETRYING:   frozenset({StepStatus.DISPATCHED, StepStatus.ESCALATED}),
    StepStatus.ESCALATED:  frozenset({StepStatus.READY, StepStatus.ABANDONED}),
    StepStatus.PASSED:     frozenset(),
    StepStatus.ABANDONED:  frozenset(),
}


class IllegalTransition(RuntimeError):
    pass


class BudgetExhausted(RuntimeError):
    def __init__(self, needed: int, headroom: int):
        super().__init__(f"needed={needed} headroom={headroom}")
        self.needed, self.headroom = needed, headroom
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_state_transitions.py -v`
Expected: 5 passed

- [ ] **Step 7: Commit**

```bash
git add deemsvc/pyproject.toml deemsvc/src/deemsvc/__init__.py \
        deemsvc/src/deemsvc/orchestrator/__init__.py \
        deemsvc/src/deemsvc/orchestrator/state.py \
        deemsvc/tests/__init__.py deemsvc/tests/test_state_transitions.py
git commit -m "feat(deemsvc): add step status transition table"
```

---

### Task 2: Intent — frozen run spec with a stable digest

**Files:**
- Modify: `deemsvc/src/deemsvc/orchestrator/state.py`
- Create: `deemsvc/tests/test_intent.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Intent` (frozen dataclass: `goal: str`, `acceptance_criteria: tuple[str, ...]`, `protected_paths: tuple[str, ...]`, `forbidden_actions: tuple[str, ...]`, `baseline_ref: str`, property `digest: str`).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_intent.py`:

```python
import pytest

from deemsvc.orchestrator.state import Intent


def _intent(**overrides) -> Intent:
    defaults = dict(
        goal="Make ProjectionCache invalidate on schema migration",
        acceptance_criteria=("AC-3: cache keyed by schema_version",),
        protected_paths=("migrations/",),
        forbidden_actions=("force-push",),
        baseline_ref="abc123",
    )
    defaults.update(overrides)
    return Intent(**defaults)


def test_intent_is_frozen():
    intent = _intent()
    with pytest.raises(AttributeError):
        intent.goal = "different goal"  # type: ignore[misc]


def test_digest_is_stable_for_identical_intent():
    assert _intent().digest == _intent().digest


def test_digest_changes_when_any_field_changes():
    base = _intent().digest
    assert _intent(goal="different goal").digest != base
    assert _intent(baseline_ref="def456").digest != base
    assert _intent(acceptance_criteria=("AC-4",)).digest != base


def test_digest_is_a_16_char_hex_string():
    digest = _intent().digest
    assert len(digest) == 16
    int(digest, 16)  # raises ValueError if not hex
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_intent.py -v`
Expected: FAIL with `ImportError: cannot import name 'Intent'`

- [ ] **Step 3: Implement Intent**

Add to `deemsvc/src/deemsvc/orchestrator/state.py` (near the top, after the imports —
add `import hashlib`, `import json`, and `from dataclasses import dataclass` to the
existing imports):

```python
import hashlib
import json
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Intent:
    """Global intent, pinned at run start. Immutable: drift is detected, never absorbed."""
    goal: str
    acceptance_criteria: tuple[str, ...]
    protected_paths: tuple[str, ...]        # e.g. ("migrations/", ".github/workflows/")
    forbidden_actions: tuple[str, ...]      # e.g. ("force-push", "dependency-major-bump")
    baseline_ref: str                       # git SHA at run start — verifier's merge-base

    @property
    def digest(self) -> str:
        canon = json.dumps(
            {"g": self.goal, "ac": self.acceptance_criteria,
             "pp": self.protected_paths, "fa": self.forbidden_actions,
             "ref": self.baseline_ref},
            sort_keys=True, separators=(",", ":"),
        )
        return hashlib.sha256(canon.encode()).hexdigest()[:16]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_intent.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/orchestrator/state.py deemsvc/tests/test_intent.py
git commit -m "feat(deemsvc): add frozen Intent with stable digest"
```

---

### Task 3: TokenBudget — reservation/commit accounting

**Files:**
- Modify: `deemsvc/src/deemsvc/orchestrator/state.py`
- Create: `deemsvc/tests/test_token_budget.py`

**Interfaces:**
- Consumes: `BudgetExhausted` from Task 1.
- Produces: `TokenBudget` (dataclass: `ceiling: int`, `compaction_watermark: float = 0.70`, `escalation_watermark: float = 0.92`; methods `projected_cost`, `headroom`, `pressure`, `reserve(step_id, step_class, fallback) -> int`, `commit(step_id, step_class, actual) -> None`, `release(step_id) -> None`).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_token_budget.py`:

```python
import pytest

from deemsvc.orchestrator.state import BudgetExhausted, TokenBudget


def test_reserve_then_commit_moves_reservation_to_committed():
    budget = TokenBudget(ceiling=1000)
    budget.reserve("s1", "generate", fallback=200)
    assert budget.headroom() == 800
    budget.commit("s1", "generate", actual=180)
    assert budget.headroom() == 820
    assert budget.pressure() == pytest.approx(0.18)


def test_reserve_exceeding_headroom_raises_budget_exhausted():
    budget = TokenBudget(ceiling=100)
    budget.reserve("s1", "generate", fallback=90)
    with pytest.raises(BudgetExhausted) as exc:
        budget.reserve("s2", "generate", fallback=50)
    assert exc.value.needed == 50
    assert exc.value.headroom == 10


def test_release_frees_reservation_without_committing():
    budget = TokenBudget(ceiling=100)
    budget.reserve("s1", "generate", fallback=90)
    budget.release("s1")
    assert budget.headroom() == 100
    assert budget.pressure() == 0


def test_commit_updates_ewma_for_future_projections():
    budget = TokenBudget(ceiling=10_000)
    budget.reserve("s1", "generate", fallback=1000)
    budget.commit("s1", "generate", actual=2000)
    # EWMA_ALPHA=0.30: 0.30*2000 + 0.70*1000 = 1300
    assert budget.projected_cost("generate", fallback=1000) == 1300


def test_concurrent_reservations_never_exceed_ceiling():
    budget = TokenBudget(ceiling=1000)
    reserved = []
    for i in range(5):
        try:
            reserved.append(budget.reserve(f"s{i}", "generate", fallback=250))
        except BudgetExhausted:
            pass
    # At most 4 reservations of 250 fit in a ceiling of 1000.
    assert sum(reserved) <= 1000
    assert len(reserved) == 4
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_token_budget.py -v`
Expected: FAIL with `ImportError: cannot import name 'TokenBudget'`

- [ ] **Step 3: Implement TokenBudget**

Add to `deemsvc/src/deemsvc/orchestrator/state.py` (add `from dataclasses import field`
to the existing `dataclasses` import so it reads `from dataclasses import dataclass, field`):

```python
@dataclass
class TokenBudget:
    """Hierarchical reservation/commit accounting with EWMA cost projection.

    Invariant: committed + sum(reservations) <= ceiling, always — including
    with N steps concurrently in flight.
    """
    ceiling: int
    compaction_watermark: float = 0.70   # trigger context compaction on workers
    escalation_watermark: float = 0.92   # refuse new dispatches; drain and escalate
    _committed: int = 0
    _reservations: dict[str, int] = field(default_factory=dict)
    _ewma: dict[str, float] = field(default_factory=dict)
    _fallbacks: dict[str, int] = field(default_factory=dict)
    _EWMA_ALPHA: float = 0.30

    def projected_cost(self, step_class: str, fallback: int) -> int:
        return int(self._ewma.get(step_class, float(fallback)))

    def headroom(self) -> int:
        return self.ceiling - self._committed - sum(self._reservations.values())

    def pressure(self) -> float:
        return (self._committed + sum(self._reservations.values())) / self.ceiling

    def reserve(self, step_id: str, step_class: str, fallback: int) -> int:
        est = self.projected_cost(step_class, fallback)
        if est > self.headroom():
            raise BudgetExhausted(needed=est, headroom=self.headroom())
        self._reservations[step_id] = est
        if step_class not in self._fallbacks:
            self._fallbacks[step_class] = fallback
        return est

    def commit(self, step_id: str, step_class: str, actual: int) -> None:
        self._reservations.pop(step_id, None)
        self._committed += actual
        if step_class not in self._ewma:
            prev = float(self._fallbacks.get(step_class, actual))
        else:
            prev = self._ewma[step_class]
        self._ewma[step_class] = self._EWMA_ALPHA * actual + (1 - self._EWMA_ALPHA) * prev

    def release(self, step_id: str) -> None:
        self._reservations.pop(step_id, None)
```

**Note (corrected after implementation):** the version above fixes a bug in this
plan's original reference code — the original body computed `prev = self._ewma.get(step_class,
float(actual))` on first commit, which seeds the EWMA at `actual` itself and makes
the first commit a no-op on the running average (`0.3*actual + 0.7*actual == actual`,
never `fallback`). That silently broke this task's own `test_commit_updates_ewma_for_future_projections`
assertion (`ewma == 1300` for `fallback=1000, actual=2000`), since the original code
produces `2000` instead. The `_fallbacks` dict captures each step class's fallback at
first `reserve()`, so `commit()` can seed the EWMA from the fallback rather than from
`actual` — preserving the `reserve`/`commit` signatures unchanged (no `fallback` param
was added to `commit`) while making the documented `1300` result actually reachable.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_token_budget.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/orchestrator/state.py deemsvc/tests/test_token_budget.py
git commit -m "feat(deemsvc): add TokenBudget reserve/commit accounting"
```

---

### Task 4: Step, StepResult, and a scripted stub dispatcher for tests

**Files:**
- Modify: `deemsvc/src/deemsvc/orchestrator/state.py`
- Create: `deemsvc/src/deemsvc/orchestrator/stub_dispatch.py`
- Create: `deemsvc/tests/test_stub_dispatch.py`

**Interfaces:**
- Consumes: `StepStatus` from Task 1.
- Produces: `Step` (dataclass: `id: str`, `step_class: str`, `payload: dict`, `deps: frozenset[str]`, `status: StepStatus = BLOCKED`, `attempts: int = 0`, `max_attempts: int = 3`, `fallback_cost: int = 40_000`, `feedback: dict | None = None`), `StepResult` (dataclass: `step_id: str`, `verdict: Literal["pass","retry","escalate"]`, `tokens_spent: int`, `evidence: dict`, `feedback: dict | None = None`), `ScriptedDispatcher` (async callable: `script: dict[str, list[str]]` — per-step-id verdict sequence, repeats last entry once exhausted).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_stub_dispatch.py`:

```python
import pytest

from deemsvc.orchestrator.state import Step, StepStatus
from deemsvc.orchestrator.stub_dispatch import ScriptedDispatcher


@pytest.mark.asyncio
async def test_dispatcher_returns_scripted_verdict_by_attempt():
    dispatcher = ScriptedDispatcher(script={"impl": ["retry", "pass"]})
    step = Step(id="impl", step_class="generate", payload={}, deps=frozenset(),
                status=StepStatus.EXECUTING, attempts=1)
    first = await dispatcher(step)
    assert first.verdict == "retry"
    assert first.feedback is not None

    step.attempts = 2
    second = await dispatcher(step)
    assert second.verdict == "pass"


@pytest.mark.asyncio
async def test_dispatcher_defaults_to_pass_for_unscripted_steps():
    dispatcher = ScriptedDispatcher(script={})
    step = Step(id="explore", step_class="explore", payload={}, deps=frozenset(),
                status=StepStatus.EXECUTING, attempts=1)
    result = await dispatcher(step)
    assert result.verdict == "pass"


@pytest.mark.asyncio
async def test_dispatcher_records_calls_in_order():
    dispatcher = ScriptedDispatcher(script={})
    step = Step(id="s1", step_class="generate", payload={}, deps=frozenset(),
                status=StepStatus.EXECUTING, attempts=1)
    await dispatcher(step)
    await dispatcher(step)
    assert dispatcher.calls == ["s1", "s1"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_stub_dispatch.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'deemsvc.orchestrator.stub_dispatch'`

- [ ] **Step 3: Implement Step, StepResult, and ScriptedDispatcher**

Add to `deemsvc/src/deemsvc/orchestrator/state.py` (add `from typing import Literal` to imports):

```python
@dataclass
class Step:
    id: str
    step_class: str                     # "explore" | "generate" | "verify" | "integrate"
    payload: dict
    deps: frozenset[str]
    status: StepStatus = StepStatus.BLOCKED
    attempts: int = 0
    max_attempts: int = 3
    fallback_cost: int = 40_000
    feedback: dict | None = None        # verifier feedback packet threaded into retries


@dataclass
class StepResult:
    step_id: str
    verdict: Literal["pass", "retry", "escalate"]
    tokens_spent: int
    evidence: dict                      # digests, junit transitions, exit codes
    feedback: dict | None = None
```

`deemsvc/src/deemsvc/orchestrator/stub_dispatch.py`:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from .state import Step, StepResult


@dataclass
class ScriptedDispatcher:
    """Deterministic stub dispatch callable for tests. `script` maps step id to a
    list of verdicts, one per attempt; once the list is exhausted the last entry
    repeats. Steps with no script entry always pass on the first attempt."""
    script: dict[str, list[Literal["pass", "retry", "escalate"]]] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)

    async def __call__(self, step: Step) -> StepResult:
        self.calls.append(step.id)
        verdicts = self.script.get(step.id, ["pass"])
        idx = min(step.attempts - 1, len(verdicts) - 1)
        verdict = verdicts[idx]
        evidence = {"attempt": step.attempts, "step_class": step.step_class}
        feedback = {"note": f"retry {step.attempts}"} if verdict == "retry" else None
        return StepResult(step.id, verdict, tokens_spent=1000, evidence=evidence, feedback=feedback)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_stub_dispatch.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/orchestrator/state.py \
        deemsvc/src/deemsvc/orchestrator/stub_dispatch.py \
        deemsvc/tests/test_stub_dispatch.py
git commit -m "feat(deemsvc): add Step/StepResult and a scripted stub dispatcher"
```

---

### Task 5: Orchestrator — frontier scheduling, retry, and cascade abandonment

**Files:**
- Modify: `deemsvc/src/deemsvc/orchestrator/state.py`
- Create: `deemsvc/tests/conftest.py`
- Create: `deemsvc/tests/test_orchestrator_run.py`

**Interfaces:**
- Consumes: `Intent`, `TokenBudget`, `Step`, `StepStatus`, `StepResult`, `IllegalTransition`, `_LEGAL` from Tasks 1-4; `ScriptedDispatcher` from Task 4.
- Produces: `Orchestrator` (class: `__init__(intent, budget, dispatch, journal, max_concurrency=4)`; `async def run(graph: dict[str, Step]) -> dict[str, Step]`).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/conftest.py`:

```python
import pytest

from deemsvc.orchestrator.state import Intent


@pytest.fixture
def intent() -> Intent:
    return Intent(
        goal="test goal",
        acceptance_criteria=("AC-1",),
        protected_paths=(),
        forbidden_actions=(),
        baseline_ref="0" * 40,
    )
```

`deemsvc/tests/test_orchestrator_run.py`:

```python
import pytest

from deemsvc.orchestrator.state import Orchestrator, Step, StepStatus, TokenBudget
from deemsvc.orchestrator.stub_dispatch import ScriptedDispatcher


def _graph(*steps: Step) -> dict[str, Step]:
    return {s.id: s for s in steps}


@pytest.mark.asyncio
async def test_independent_steps_all_pass(intent):
    dispatcher = ScriptedDispatcher()
    journal: list[dict] = []
    orch = Orchestrator(intent, TokenBudget(ceiling=100_000), dispatcher, journal.append)
    graph = _graph(
        Step(id="a", step_class="explore", payload={}, deps=frozenset()),
        Step(id="b", step_class="explore", payload={}, deps=frozenset()),
    )
    result = await orch.run(graph)
    assert result["a"].status is StepStatus.PASSED
    assert result["b"].status is StepStatus.PASSED
    assert len(journal) > 0


@pytest.mark.asyncio
async def test_dependent_step_waits_for_dependency(intent):
    dispatcher = ScriptedDispatcher()
    orch = Orchestrator(intent, TokenBudget(ceiling=100_000), dispatcher, lambda r: None)
    graph = _graph(
        Step(id="a", step_class="explore", payload={}, deps=frozenset()),
        Step(id="b", step_class="generate", payload={}, deps=frozenset({"a"})),
    )
    result = await orch.run(graph)
    assert result["a"].status is StepStatus.PASSED
    assert result["b"].status is StepStatus.PASSED
    # b must have been dispatched after a passed
    assert dispatcher.calls.index("a") < dispatcher.calls.index("b")


@pytest.mark.asyncio
async def test_retry_then_pass_reaches_passed_with_two_attempts(intent):
    dispatcher = ScriptedDispatcher(script={"impl": ["retry", "pass"]})
    orch = Orchestrator(intent, TokenBudget(ceiling=100_000), dispatcher, lambda r: None)
    graph = _graph(Step(id="impl", step_class="generate", payload={}, deps=frozenset(),
                        max_attempts=3))
    result = await orch.run(graph)
    assert result["impl"].status is StepStatus.PASSED
    assert result["impl"].attempts == 2


@pytest.mark.asyncio
async def test_repeated_retry_escalates_at_attempt_ceiling(intent):
    dispatcher = ScriptedDispatcher(script={"impl": ["retry", "retry", "retry"]})
    orch = Orchestrator(intent, TokenBudget(ceiling=100_000), dispatcher, lambda r: None)
    graph = _graph(Step(id="impl", step_class="generate", payload={}, deps=frozenset(),
                        max_attempts=2))
    result = await orch.run(graph)
    assert result["impl"].status is StepStatus.ESCALATED
    assert result["impl"].attempts == 2


@pytest.mark.asyncio
async def test_failed_step_abandons_transitive_dependents(intent):
    dispatcher = ScriptedDispatcher(script={"a": ["escalate"]})
    orch = Orchestrator(intent, TokenBudget(ceiling=100_000), dispatcher, lambda r: None)
    graph = _graph(
        Step(id="a", step_class="generate", payload={}, deps=frozenset(), max_attempts=1),
        Step(id="b", step_class="verify", payload={}, deps=frozenset({"a"})),
        Step(id="c", step_class="integrate", payload={}, deps=frozenset({"b"})),
    )
    result = await orch.run(graph)
    assert result["a"].status is StepStatus.ESCALATED
    assert result["b"].status is StepStatus.ABANDONED
    assert result["c"].status is StepStatus.ABANDONED


@pytest.mark.asyncio
async def test_budget_exhaustion_escalates_instead_of_dispatching(intent):
    dispatcher = ScriptedDispatcher()
    tiny_budget = TokenBudget(ceiling=10)  # smaller than any fallback_cost
    orch = Orchestrator(intent, tiny_budget, dispatcher, lambda r: None)
    graph = _graph(Step(id="a", step_class="generate", payload={}, deps=frozenset(),
                        fallback_cost=1000))
    result = await orch.run(graph)
    assert result["a"].status is StepStatus.ESCALATED
    assert dispatcher.calls == []  # never dispatched — budget check happens first
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_orchestrator_run.py -v`
Expected: FAIL with `ImportError: cannot import name 'Orchestrator'`

- [ ] **Step 3: Implement Orchestrator**

Add to `deemsvc/src/deemsvc/orchestrator/state.py` (add `import asyncio`, `import time`,
and `from typing import Awaitable, Callable` to imports):

```python
import asyncio
import time
from typing import Awaitable, Callable


class Orchestrator:
    def __init__(
        self,
        intent: Intent,
        budget: TokenBudget,
        dispatch: Callable[[Step], Awaitable[StepResult]],
        journal: Callable[[dict], None],
        max_concurrency: int = 4,
    ):
        self.intent, self.budget = intent, budget
        self._dispatch, self._journal = dispatch, journal
        self._sem = asyncio.Semaphore(max_concurrency)

    def _transition(self, step: Step, to: StepStatus) -> None:
        if to not in _LEGAL[step.status]:
            raise IllegalTransition(f"{step.id}: {step.status} -> {to}")
        self._journal({"ts": time.time(), "step": step.id,
                       "from": step.status, "to": to,
                       "intent_digest": self.intent.digest,
                       "budget_pressure": round(self.budget.pressure(), 4)})
        step.status = to

    def _frontier(self, graph: dict[str, Step]) -> list[Step]:
        for s in graph.values():
            if s.status is StepStatus.BLOCKED and all(
                graph[d].status is StepStatus.PASSED for d in s.deps
            ):
                self._transition(s, StepStatus.READY)
        return [s for s in graph.values() if s.status is StepStatus.READY]

    def _abandon_dependents(self, graph: dict[str, Step], failed_id: str) -> None:
        doomed, stack = set(), [failed_id]
        while stack:
            cur = stack.pop()
            for s in graph.values():
                if cur in s.deps and s.id not in doomed:
                    doomed.add(s.id)
                    stack.append(s.id)
        for sid in doomed:
            if graph[sid].status not in (StepStatus.PASSED, StepStatus.ABANDONED):
                self._transition(graph[sid], StepStatus.ABANDONED)

    async def _run_step(self, step: Step) -> StepResult:
        async with self._sem:
            self._transition(step, StepStatus.EXECUTING)
            step.attempts += 1
            return await self._dispatch(step)

    async def run(self, graph: dict[str, Step]) -> dict[str, Step]:
        inflight: dict[asyncio.Task[StepResult], Step] = {}
        while True:
            if self.budget.pressure() < self.budget.escalation_watermark:
                for step in self._frontier(graph):
                    try:
                        self.budget.reserve(step.id, step.step_class, step.fallback_cost)
                    except BudgetExhausted:
                        self._transition(step, StepStatus.ESCALATED)
                        continue
                    self._transition(step, StepStatus.DISPATCHED)
                    inflight[asyncio.create_task(self._run_step(step))] = step

            if not inflight:
                stuck = [s for s in graph.values()
                         if s.status not in (StepStatus.PASSED, StepStatus.ABANDONED,
                                             StepStatus.ESCALATED)]
                if stuck:  # cycle or budget starvation — surface, don't spin
                    for s in stuck:
                        self._transition(s, StepStatus.ESCALATED)
                return graph

            done, _ = await asyncio.wait(inflight, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                step = inflight.pop(task)
                result = task.result()
                self.budget.commit(step.id, step.step_class, result.tokens_spent)
                match result.verdict:
                    case "pass":
                        self._transition(step, StepStatus.VERIFYING)
                        self._transition(step, StepStatus.PASSED)
                    case "retry" if step.attempts < step.max_attempts:
                        step.feedback = result.feedback
                        self._transition(step, StepStatus.RETRYING)
                        self._transition(step, StepStatus.DISPATCHED)
                        inflight[asyncio.create_task(self._run_step(step))] = step
                    case _:
                        self._transition(step, StepStatus.ESCALATED)
                        self._abandon_dependents(graph, step.id)
```

Note: this drops the blueprint's separate `escalation_cutoff()` method (it returned
only `self.budget.escalation_watermark` with no added logic) and reads the watermark
directly — same behavior, one less indirection.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_orchestrator_run.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/orchestrator/state.py deemsvc/tests/conftest.py \
        deemsvc/tests/test_orchestrator_run.py
git commit -m "feat(deemsvc): add Orchestrator frontier scheduler with retry/escalation"
```

---

### Task 6: JsonlJournal — write-ahead durability

**Files:**
- Create: `deemsvc/src/deemsvc/orchestrator/journal.py`
- Create: `deemsvc/tests/test_journal.py`

**Interfaces:**
- Consumes: `StepStatus` from Task 1.
- Produces: `JsonlJournal` (class: `__init__(path: str)`; `append(record: dict) -> None`; `close() -> None`; staticmethod `replay(path: str) -> dict[str, StepStatus]` — last recorded `to` status per step id).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_journal.py`:

```python
import json

from deemsvc.orchestrator.journal import JsonlJournal
from deemsvc.orchestrator.state import StepStatus


def test_append_writes_one_json_line_per_record(tmp_path):
    path = tmp_path / "run.jsonl"
    journal = JsonlJournal(str(path))
    journal.append({"step": "a", "from": "blocked", "to": "ready"})
    journal.append({"step": "a", "from": "ready", "to": "dispatched"})
    journal.close()

    lines = path.read_text().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["to"] == "ready"
    assert json.loads(lines[1])["to"] == "dispatched"


def test_replay_returns_last_status_per_step(tmp_path):
    path = tmp_path / "run.jsonl"
    journal = JsonlJournal(str(path))
    journal.append({"step": "a", "from": "blocked", "to": "ready"})
    journal.append({"step": "a", "from": "ready", "to": "dispatched"})
    journal.append({"step": "b", "from": "blocked", "to": "ready"})
    journal.close()

    statuses = JsonlJournal.replay(str(path))
    assert statuses == {"a": StepStatus.DISPATCHED, "b": StepStatus.READY}


def test_replay_of_missing_file_returns_empty_dict(tmp_path):
    assert JsonlJournal.replay(str(tmp_path / "does-not-exist.jsonl")) == {}


def test_replay_skips_blank_lines(tmp_path):
    path = tmp_path / "run.jsonl"
    path.write_text('{"step": "a", "from": "blocked", "to": "ready"}\n\n')
    assert JsonlJournal.replay(str(path)) == {"a": StepStatus.READY}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_journal.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'deemsvc.orchestrator.journal'`

- [ ] **Step 3: Implement JsonlJournal**

`deemsvc/src/deemsvc/orchestrator/journal.py`:

```python
from __future__ import annotations

import json
import os

from .state import StepStatus


class JsonlJournal:
    """Write-ahead event log. Every Orchestrator transition is appended here
    before it takes effect (see state.py:Orchestrator._transition), so a crash
    mid-run leaves either a complete or a missing final line — never a corrupt one."""

    def __init__(self, path: str):
        self.path = path
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self._fh = open(path, "a", buffering=1)

    def append(self, record: dict) -> None:
        self._fh.write(json.dumps(record, sort_keys=True, default=str) + "\n")
        self._fh.flush()
        os.fsync(self._fh.fileno())

    def close(self) -> None:
        self._fh.close()

    @staticmethod
    def replay(path: str) -> dict[str, StepStatus]:
        """Last recorded status per step id, in journal order."""
        if not os.path.exists(path):
            return {}
        last: dict[str, str] = {}
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                last[rec["step"]] = rec["to"]
        return {step_id: StepStatus(status) for step_id, status in last.items()}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_journal.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/orchestrator/journal.py deemsvc/tests/test_journal.py
git commit -m "feat(deemsvc): add write-ahead JSONL journal with replay"
```

---

### Task 7: Crash-resume — journal replay reconstructs an in-flight run

**Files:**
- Modify: `deemsvc/src/deemsvc/orchestrator/journal.py`
- Create: `deemsvc/tests/test_crash_resume.py`

**Interfaces:**
- Consumes: `JsonlJournal.replay`, `Step`, `StepStatus`, `Orchestrator._frontier` (via a full `run()` call — no new public API needed on `Orchestrator` itself).
- Produces: `resume_graph(graph: dict[str, Step], journal_path: str) -> None` — mutates `graph` in place, applying replayed terminal statuses and resetting any in-flight status to `BLOCKED` so the next `Orchestrator.run()` call recomputes the frontier correctly.

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_crash_resume.py`:

```python
import pytest

from deemsvc.orchestrator.journal import JsonlJournal, resume_graph
from deemsvc.orchestrator.state import Orchestrator, Step, StepStatus, TokenBudget
from deemsvc.orchestrator.stub_dispatch import ScriptedDispatcher


def test_resume_graph_restores_terminal_statuses(tmp_path):
    path = str(tmp_path / "run.jsonl")
    journal = JsonlJournal(path)
    journal.append({"step": "a", "from": "verifying", "to": "passed"})
    journal.close()

    graph = {"a": Step(id="a", step_class="generate", payload={}, deps=frozenset())}
    resume_graph(graph, path)
    assert graph["a"].status is StepStatus.PASSED


def test_resume_graph_resets_inflight_status_to_blocked(tmp_path):
    path = str(tmp_path / "run.jsonl")
    journal = JsonlJournal(path)
    journal.append({"step": "a", "from": "dispatched", "to": "executing"})  # crash here
    journal.close()

    graph = {"a": Step(id="a", step_class="generate", payload={}, deps=frozenset())}
    resume_graph(graph, path)
    assert graph["a"].status is StepStatus.BLOCKED


def test_resume_graph_ignores_steps_not_in_current_graph(tmp_path):
    path = str(tmp_path / "run.jsonl")
    journal = JsonlJournal(path)
    journal.append({"step": "stale-step", "from": "blocked", "to": "ready"})
    journal.close()

    graph = {"a": Step(id="a", step_class="generate", payload={}, deps=frozenset())}
    resume_graph(graph, path)  # must not raise KeyError
    assert graph["a"].status is StepStatus.BLOCKED


@pytest.mark.asyncio
async def test_resumed_run_reaches_passed_after_simulated_crash(tmp_path):
    path = str(tmp_path / "run.jsonl")
    intent_journal = JsonlJournal(path)
    # Simulate a crash after "a" passed but before "b" (which depends on "a") finished.
    intent_journal.append({"step": "a", "from": "verifying", "to": "passed"})
    intent_journal.append({"step": "b", "from": "dispatched", "to": "executing"})
    intent_journal.close()

    graph = {
        "a": Step(id="a", step_class="explore", payload={}, deps=frozenset()),
        "b": Step(id="b", step_class="generate", payload={}, deps=frozenset({"a"})),
    }
    resume_graph(graph, path)
    assert graph["a"].status is StepStatus.PASSED
    assert graph["b"].status is StepStatus.BLOCKED  # will re-enter READY via _frontier

    from deemsvc.orchestrator.state import Intent
    resumed_intent = Intent(goal="g", acceptance_criteria=(), protected_paths=(),
                            forbidden_actions=(), baseline_ref="0" * 40)
    resume_journal = JsonlJournal(path)
    dispatcher = ScriptedDispatcher()
    orch = Orchestrator(resumed_intent, TokenBudget(ceiling=100_000), dispatcher,
                        resume_journal.append)
    result = await orch.run(graph)
    resume_journal.close()

    assert result["b"].status is StepStatus.PASSED
    # "a" was never re-dispatched — it was already terminal.
    assert "a" not in dispatcher.calls
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_crash_resume.py -v`
Expected: FAIL with `ImportError: cannot import name 'resume_graph'`

- [ ] **Step 3: Implement resume_graph**

Add to `deemsvc/src/deemsvc/orchestrator/journal.py` (add `from .state import Step` to
the existing `from .state import StepStatus` import line so it reads
`from .state import Step, StepStatus`):

```python
_INFLIGHT = frozenset({
    StepStatus.DISPATCHED, StepStatus.EXECUTING, StepStatus.VERIFYING, StepStatus.RETRYING,
})


def resume_graph(graph: dict[str, Step], journal_path: str) -> None:
    """Apply the last recorded status from `journal_path` onto `graph` in place.

    Terminal statuses (PASSED, ABANDONED, ESCALATED) are restored as-is. In-flight
    statuses are reset to BLOCKED rather than the blueprint's literal "re-enter READY":
    resetting to BLOCKED and letting Orchestrator._frontier() recompute READY from
    current dependency state is the only way to guarantee a step already missing a
    passed dependency isn't dispatched again — the same safety Orchestrator.run()
    already relies on for the ordinary (non-crash) frontier walk.
    """
    statuses = JsonlJournal.replay(journal_path)
    for step_id, status in statuses.items():
        if step_id not in graph:
            continue
        graph[step_id].status = StepStatus.BLOCKED if status in _INFLIGHT else status
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_crash_resume.py -v`
Expected: 4 passed

- [ ] **Step 5: Run the full test suite**

Run: `cd deemsvc && .venv/bin/pytest -v`
Expected: all tests across every file in this plan pass (30+ tests, 0 failures).

- [ ] **Step 6: Commit**

```bash
git add deemsvc/src/deemsvc/orchestrator/journal.py deemsvc/tests/test_crash_resume.py
git commit -m "feat(deemsvc): add crash-resume via journal replay"
```
