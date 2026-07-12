# deemsvc Service + Node Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the `deemsvc` Python engine (orchestrator + tool broker + verifier +
pluggable agent adapters, built in the four prior plans) over HTTP/SSE, and wire Deem's
existing Node/Express shell to spawn, supervise, and consume it — landing a new
**agent-selectable run path** (`fable5-native`, `claude-code-cli`, `codex-cli`, or any
future adapter registered in `deemsvc-fable5-dispatcher`'s registry) that runs real
tasks end to end without touching any existing UI, auth, store, or Electron code.

**Architecture:** A `GenerateThenVerifyDispatcher` closes the one architectural gap
left open by the prior plans: it composes *whichever* `AgentAdapter` a run selects
(proposes a candidate) with `VerifierEngine` (arbitrates it), so the Orchestrator's
`dispatch` callable never treats an agent's self-report as authoritative — matching
`docs/AI-CODING-AGENT-ARCHITECTURAL-BLUEPRINT.md` §8.5's closing invariant, and holding
uniformly whether the candidate came from the Anthropic API or a CLI subprocess. A
FastAPI app wraps `Orchestrator.run()` in `POST /runs` (which accepts an `agent` field
selecting the adapter by name) / `GET /runs/{id}/events` (SSE) / `POST /runs/{id}/resume`
/ `GET /runs/{id}/state` / `GET /health`. On the Node side, a supervisor spawns `deemsvc`
as a managed child process (mirroring the `spawn()` pattern already used in
`server/agents/claude.js`/`codex.js`), a client talks to it over HTTP, and a projector
maps its SSE journal events onto the existing `data/deem.json` shape via `store.js` —
per `docs/specs/2026-07-12-fable5-engine-rebuild-design.md` §2 and §4.

**Tech Stack:** Python: `fastapi`, `uvicorn[standard]`, `httpx` (test client). Node:
built-in `node:child_process` and `node:http`/`node:https` only — no new npm
dependencies, matching the existing minimal-dependency footprint in `package.json`.

## Global Constraints

- Depends on all four prior plans: `deemsvc-orchestrator-core`, `deemsvc-tool-broker`,
  `deemsvc-verifier-engine`, `deemsvc-fable5-dispatcher`.
- **Scope reduction, stated explicitly:** the run graph this plan wires end to end is a
  single `"generate"`-class step (Generator → Verifier), not the full
  `explore → generate → verify → integrate` DAG described in the blueprint's Standardized
  Quality Pipeline (§6). Building the Explorer and Integrate steps and a multi-step DAG
  is future work, tracked as a follow-up plan — this plan's job is to prove the full
  Node ↔ Python ↔ Anthropic API path works for one verified generation, not to reach
  feature parity with the old six-phase pipeline in one pass.
- **Also deferred, follow-on plans:** `task.heartbeat` messages (blueprint §4.1) — this
  plan's debug-view data comes entirely from journal transitions, not live heartbeats,
  so tool-call-in-progress granularity is coarser than the spec's component-mapping
  table (§3) describes until a follow-up plan adds heartbeat emission to each
  `AgentAdapter` and a corresponding `server/monitor.js` consumer; and the
  evidence-bundle audit writer (blueprint §6 Stage 4, spec §3's `audit.js` row) — this
  plan's `server/audit.js` is untouched, so Fable-5-native runs are not yet audited the
  way Claude/Codex runs are. Both are real gaps against the full blueprint, called out
  here rather than silently dropped, and neither blocks this plan's goal of proving the
  end-to-end path for one verified generation.
- The new engine is additive: `server/workflow.js` and `server/agents/{claude,codex}.js`
  are untouched. Per `docs/specs/2026-07-12-fable5-engine-rebuild-design.md` §5
  (shadow-run rollout), cutover/deletion of the old engine is explicitly out of scope
  here.
- Node spawns exactly one `deemsvc` process per Deem server instance, on API boot,
  supervised the way `server/agents/*.js` already supervise agent subprocesses (spawn,
  watch, kill on shutdown) — see `server/index.js:1-18` for the existing import/wiring
  style this plan follows.
- Source references: `docs/AI-CODING-AGENT-ARCHITECTURAL-BLUEPRINT.md` §8.5 (dispatcher
  composition invariant), `docs/specs/2026-07-12-fable5-engine-rebuild-design.md` §2-5
  (process topology, component mapping, persistence bridge, rollout).

---

### Task 1: GenerateThenVerifyDispatcher — the Generator/Verifier composition

**Files:**
- Create: `deemsvc/src/deemsvc/service/__init__.py`
- Create: `deemsvc/src/deemsvc/service/dispatch.py`
- Create: `deemsvc/tests/test_service_dispatch_compose.py`

**Interfaces:**
- Consumes: `Step`, `StepResult`, `Intent`, `TokenBudget` from `deemsvc-orchestrator-core`; `VerificationTask`, `Verdict`, `VerifierEngine` from `deemsvc-verifier-engine`; `AgentAdapter` from `deemsvc-fable5-dispatcher` (any concrete implementation — `FableDispatcher`, `CliAgentAdapter`, or a future backend — composes identically here).
- Produces: `GenerateThenVerifyDispatcher` (class: `__init__(agent: AgentAdapter, verifier_factory: Callable[[str], VerifierEngine], intent: Intent, budget: TokenBudget)`; `async def __call__(step: Step) -> StepResult`).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_service_dispatch_compose.py`:

```python
from unittest.mock import AsyncMock

import pytest

from deemsvc.orchestrator.state import Intent, Step, StepResult, TokenBudget
from deemsvc.service.dispatch import GenerateThenVerifyDispatcher
from deemsvc.verifier.engine import Verdict


def _intent() -> Intent:
    return Intent(goal="g", acceptance_criteria=("AC-1",), protected_paths=(),
                 forbidden_actions=(), baseline_ref="0" * 40)


def _step(step_class="generate", **overrides) -> Step:
    defaults = dict(id="impl", step_class=step_class, deps=frozenset(),
                    payload={"capability_grant": {"worktree": "/tmp/wt"}})
    defaults.update(overrides)
    return Step(**defaults)


@pytest.mark.asyncio
async def test_verifier_pass_becomes_step_result_pass():
    # AsyncMock stands in for any AgentAdapter — FableDispatcher, CliAgentAdapter,
    # or a future backend — since GenerateThenVerifyDispatcher only calls it.
    agent = AsyncMock(return_value=StepResult(
        "impl", "pass", 1000, {"candidate_ref": "a" * 40}))
    verifier = AsyncMock()
    verifier.verify = AsyncMock(return_value=Verdict("pass", "sig1"))
    dispatcher = GenerateThenVerifyDispatcher(
        agent, verifier_factory=lambda repo_root: verifier,
        intent=_intent(), budget=TokenBudget(ceiling=1_000_000))

    result = await dispatcher(_step())
    assert result.verdict == "pass"
    verifier.verify.assert_awaited_once()


@pytest.mark.asyncio
async def test_verifier_retry_carries_feedback_into_the_step_result():
    agent = AsyncMock(return_value=StepResult(
        "impl", "pass", 1000, {"candidate_ref": "b" * 40}))
    verifier = AsyncMock()
    feedback = {"instruction": "fix only the regression"}
    verifier.verify = AsyncMock(return_value=Verdict("retry", "sig2", feedback=feedback))
    dispatcher = GenerateThenVerifyDispatcher(
        agent, verifier_factory=lambda repo_root: verifier,
        intent=_intent(), budget=TokenBudget(ceiling=1_000_000))

    result = await dispatcher(_step())
    assert result.verdict == "retry"
    assert result.feedback == feedback


@pytest.mark.asyncio
async def test_agent_self_reported_pass_is_never_trusted_without_verification():
    # Even though the agent proposes "pass" — whatever backend it is — the
    # Verifier's "escalate" must be what the Orchestrator sees.
    agent = AsyncMock(return_value=StepResult(
        "impl", "pass", 1000, {"candidate_ref": "c" * 40}))
    verifier = AsyncMock()
    verifier.verify = AsyncMock(return_value=Verdict("escalate", "sig3", reason="attempt ceiling"))
    dispatcher = GenerateThenVerifyDispatcher(
        agent, verifier_factory=lambda repo_root: verifier,
        intent=_intent(), budget=TokenBudget(ceiling=1_000_000))

    result = await dispatcher(_step())
    assert result.verdict == "escalate"


@pytest.mark.asyncio
async def test_a_proposed_retry_from_the_agent_skips_verification_entirely():
    # If the agent itself never produced a candidate_ref, there is nothing for
    # the Verifier to check — don't spend a verification cycle on it.
    agent = AsyncMock(return_value=StepResult("impl", "retry", 500, {"candidate_ref": ""}))
    verifier = AsyncMock()
    dispatcher = GenerateThenVerifyDispatcher(
        agent, verifier_factory=lambda repo_root: verifier,
        intent=_intent(), budget=TokenBudget(ceiling=1_000_000))

    result = await dispatcher(_step())
    assert result.verdict == "retry"
    verifier.verify.assert_not_called()


@pytest.mark.asyncio
async def test_non_generate_steps_bypass_verification_entirely():
    agent = AsyncMock(return_value=StepResult("explore", "pass", 200, {}))
    verifier = AsyncMock()
    dispatcher = GenerateThenVerifyDispatcher(
        agent, verifier_factory=lambda repo_root: verifier,
        intent=_intent(), budget=TokenBudget(ceiling=1_000_000))

    result = await dispatcher(_step(step_class="explore"))
    assert result.verdict == "pass"
    verifier.verify.assert_not_called()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_service_dispatch_compose.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'deemsvc.service'`

- [ ] **Step 3: Implement GenerateThenVerifyDispatcher**

`deemsvc/src/deemsvc/service/__init__.py`: empty file.

`deemsvc/src/deemsvc/service/dispatch.py`:

```python
from __future__ import annotations

from deemsvc.orchestrator.state import Intent, Step, StepResult, TokenBudget
from deemsvc.sdk.adapter import AgentAdapter
from deemsvc.verifier.engine import VerificationTask, VerifierEngine
from typing import Callable


class GenerateThenVerifyDispatcher:
    """Composes any AgentAdapter (FableDispatcher, CliAgentAdapter, or a future
    backend — see deemsvc-fable5-dispatcher's registry.py) with the Verifier so
    an agent's self-reported "pass" is never authoritative, regardless of which
    backend produced it. Only "generate"-class steps that produced a real
    candidate_ref are routed to verification; every other step class, and any
    generate attempt that never committed anything, passes through the agent's
    own proposed verdict unchanged."""

    def __init__(self, agent: AgentAdapter,
                 verifier_factory: Callable[[str], VerifierEngine],
                 intent: Intent, budget: TokenBudget):
        self.agent = agent
        self.verifier_factory = verifier_factory
        self.intent = intent
        self.budget = budget

    async def __call__(self, step: Step) -> StepResult:
        proposed = await self.agent(step)
        candidate_ref = proposed.evidence.get("candidate_ref") if proposed.evidence else None
        if step.step_class != "generate" or proposed.verdict != "pass" or not candidate_ref:
            return proposed

        repo_root = step.payload["capability_grant"]["worktree"]
        verifier = self.verifier_factory(repo_root)
        prior_signatures = frozenset(step.payload.setdefault("prior_signatures", []))
        task = VerificationTask(
            step_id=step.id, repo_root=repo_root, baseline_ref=self.intent.baseline_ref,
            candidate_ref=candidate_ref, acceptance_criteria=self.intent.acceptance_criteria,
            attempt=step.attempts, max_attempts=step.max_attempts,
            prior_signatures=prior_signatures,
            changed_paths=tuple(step.payload.get("changed_paths", ())),
        )
        verdict = await verifier.verify(task, budget_headroom=self.budget.headroom())
        step.payload["prior_signatures"].append(verdict.signature)

        return StepResult(
            step.id, verdict.decision, proposed.tokens_spent,
            evidence={"candidate_ref": candidate_ref, "verdict_reason": verdict.reason,
                     "regressions": [d.test_id for d in verdict.regressions]},
            feedback=verdict.feedback,
        )
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_service_dispatch_compose.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/service/__init__.py deemsvc/src/deemsvc/service/dispatch.py \
        deemsvc/tests/test_service_dispatch_compose.py
git commit -m "feat(deemsvc): compose Generator and Verifier so self-reports are never authoritative"
```

---

### Task 2: FastAPI app skeleton, run registry, and /health

**Files:**
- Create: `deemsvc/src/deemsvc/service/registry.py`
- Create: `deemsvc/src/deemsvc/service/app.py`
- Create: `deemsvc/tests/test_service_health.py`

**Interfaces:**
- Consumes: `Step`, `JsonlJournal`.
- Produces: `RunEntry` (dataclass: `run_id, graph, task: asyncio.Task, journal: JsonlJournal, subscribers: set = set()`), `RunRegistry` (class: `create`, `get`, `publish(run_id, record)`, `subscribe(run_id) -> asyncio.Queue`, `unsubscribe(run_id, queue)`), FastAPI `app` with `GET /health` and `app.state.registry: RunRegistry`.

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_service_health.py`:

```python
import pytest
from httpx import ASGITransport, AsyncClient

from deemsvc.service.app import app


@pytest.mark.asyncio
async def test_health_returns_ok():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
```

- [ ] **Step 2: Add fastapi/uvicorn/httpx dependencies and run the test to verify it fails**

Edit `deemsvc/pyproject.toml`:

```toml
[project]
name = "deemsvc"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["anthropic>=0.40", "fastapi>=0.115", "uvicorn[standard]>=0.32"]

[project.optional-dependencies]
dev = ["pytest>=8.0", "pytest-asyncio>=0.24", "jsonschema>=4.0", "httpx>=0.27"]
```

Run:
```bash
cd deemsvc && .venv/bin/pip install -e ".[dev]" && .venv/bin/pytest tests/test_service_health.py -v
```
Expected: FAIL with `ModuleNotFoundError: No module named 'deemsvc.service.app'`

- [ ] **Step 3: Implement RunRegistry and the FastAPI skeleton**

`deemsvc/src/deemsvc/service/registry.py`:

```python
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from deemsvc.orchestrator.journal import JsonlJournal
from deemsvc.orchestrator.state import Step


@dataclass
class RunEntry:
    run_id: str
    graph: dict[str, Step]
    task: asyncio.Task | None
    journal: JsonlJournal
    agent: str = "fable5-native"        # which AgentAdapter this run uses — resume reuses it
    subscribers: set[asyncio.Queue] = field(default_factory=set)


class RunRegistry:
    def __init__(self):
        self._runs: dict[str, RunEntry] = {}

    def create(self, run_id: str, graph: dict[str, Step], journal: JsonlJournal,
              agent: str = "fable5-native") -> RunEntry:
        entry = RunEntry(run_id=run_id, graph=graph, task=None, journal=journal, agent=agent)
        self._runs[run_id] = entry
        return entry

    def get(self, run_id: str) -> RunEntry | None:
        return self._runs.get(run_id)

    def publish(self, run_id: str, record: dict) -> None:
        entry = self._runs.get(run_id)
        if not entry:
            return
        for queue in entry.subscribers:
            queue.put_nowait(record)

    def subscribe(self, run_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        entry = self._runs[run_id]
        entry.subscribers.add(queue)
        return queue

    def unsubscribe(self, run_id: str, queue: asyncio.Queue) -> None:
        entry = self._runs.get(run_id)
        if entry:
            entry.subscribers.discard(queue)
```

`deemsvc/src/deemsvc/service/app.py`:

```python
from __future__ import annotations

from fastapi import FastAPI

from .registry import RunRegistry

app = FastAPI(title="deemsvc")
app.state.registry = RunRegistry()


@app.get("/health")
async def health() -> dict:
    return {"ok": True}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_service_health.py -v`
Expected: 1 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/pyproject.toml deemsvc/src/deemsvc/service/registry.py \
        deemsvc/src/deemsvc/service/app.py deemsvc/tests/test_service_health.py
git commit -m "feat(deemsvc): add FastAPI app skeleton with a run registry and /health"
```

---

### Task 3: POST /runs — start a run against a stubbed dispatcher factory

**Files:**
- Modify: `deemsvc/src/deemsvc/service/app.py`
- Create: `deemsvc/tests/test_service_start_run.py`

**Interfaces:**
- Consumes: `RunRegistry`, `Intent`, `TokenBudget`, `Step`, `Orchestrator`, `JsonlJournal` from prior plans/tasks.
- Produces: `POST /runs` (request body: `{"goal": str, "acceptance_criteria": [str], "baseline_ref": str, "worktree": str, "token_ceiling": int, "max_attempts": int, "agent": str}` → `{"run_id": str}`; `agent` selects a backend by name from `deemsvc-fable5-dispatcher`'s adapter registry, default `"fable5-native"`). `app.state.dispatcher_factory: Callable[[Intent, TokenBudget, str], Callable[[Step], Awaitable[StepResult]]]` (the third argument is the agent name), overridable per-test so `/runs` never calls the real Anthropic API in this test suite.

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_service_start_run.py`:

```python
import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from deemsvc.orchestrator.stub_dispatch import ScriptedDispatcher
from deemsvc.service.app import app


@pytest.fixture(autouse=True)
def stub_dispatcher_factory():
    original = app.state.dispatcher_factory
    app.state.dispatcher_factory = lambda intent, budget, agent_name: ScriptedDispatcher()
    yield
    app.state.dispatcher_factory = original


@pytest.mark.asyncio
async def test_post_runs_returns_a_run_id(tmp_path):
    transport = ASGITransport(app=app)
    app.state.data_dir = str(tmp_path)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/runs", json={
            "goal": "add a flag", "acceptance_criteria": ["AC-1"],
            "baseline_ref": "0" * 40, "worktree": str(tmp_path / "wt"),
            "token_ceiling": 100_000, "max_attempts": 3,
        })
    assert resp.status_code == 200
    run_id = resp.json()["run_id"]
    assert run_id

    entry = app.state.registry.get(run_id)
    assert entry is not None
    assert entry.agent == "fable5-native"  # the default when the request omits it
    await asyncio.wait_for(entry.task, timeout=5)
    assert entry.graph["impl"].status.value == "passed"


@pytest.mark.asyncio
async def test_post_runs_honors_an_explicit_agent_choice(tmp_path):
    transport = ASGITransport(app=app)
    app.state.data_dir = str(tmp_path)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/runs", json={
            "goal": "add a flag", "acceptance_criteria": ["AC-1"],
            "baseline_ref": "0" * 40, "worktree": str(tmp_path / "wt"),
            "token_ceiling": 100_000, "max_attempts": 3, "agent": "codex-cli",
        })
    run_id = resp.json()["run_id"]
    assert app.state.registry.get(run_id).agent == "codex-cli"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_service_start_run.py -v`
Expected: FAIL with `AttributeError: 'State' object has no attribute 'dispatcher_factory'`

- [ ] **Step 3: Implement POST /runs**

Add to `deemsvc/src/deemsvc/service/app.py` (add the imports below and the default
factory + route):

```python
import asyncio
import os
import uuid

from pydantic import BaseModel

from deemsvc.orchestrator.journal import JsonlJournal
from deemsvc.orchestrator.state import Intent, Orchestrator, Step, TokenBudget


class StartRunRequest(BaseModel):
    goal: str
    acceptance_criteria: list[str]
    baseline_ref: str
    worktree: str
    token_ceiling: int = 500_000
    max_attempts: int = 4
    agent: str = "fable5-native"    # any name in deemsvc.sdk.registry.ADAPTER_FACTORIES


def _default_dispatcher_factory(intent: Intent, budget: TokenBudget, agent_name: str):
    """Production factory — builds whichever AgentAdapter `agent_name` selects
    (see deemsvc-fable5-dispatcher's registry.py), composed with the Verifier.
    Overridden in tests via app.state.dispatcher_factory so the test suite never
    calls the Anthropic API or spawns a real CLI."""
    from anthropic import AsyncAnthropic

    from deemsvc.sdk.registry import AdapterContext, build_adapter
    from deemsvc.service.dispatch import GenerateThenVerifyDispatcher
    from deemsvc.verifier.engine import VerifierEngine

    client = AsyncAnthropic()
    agent = build_adapter(agent_name, AdapterContext(client=client, run_root="."))
    return GenerateThenVerifyDispatcher(
        agent, verifier_factory=lambda repo_root: VerifierEngine(repo_root, client=client),
        intent=intent, budget=budget,
    )


app.state.dispatcher_factory = _default_dispatcher_factory
app.state.data_dir = os.environ.get("DEEMSVC_DATA_DIR", "data/runs")


@app.post("/runs")
async def start_run(req: StartRunRequest) -> dict:
    run_id = uuid.uuid4().hex[:12]
    intent = Intent(goal=req.goal, acceptance_criteria=tuple(req.acceptance_criteria),
                    protected_paths=(), forbidden_actions=(), baseline_ref=req.baseline_ref)
    budget = TokenBudget(ceiling=req.token_ceiling)
    graph = {
        "impl": Step(id="impl", step_class="generate",
                    payload={"capability_grant": {"worktree": req.worktree},
                            "objective": req.goal, "system_blocks": [], "tools": []},
                    deps=frozenset(), max_attempts=req.max_attempts),
    }

    journal_path = os.path.join(app.state.data_dir, run_id, "journal.jsonl")
    journal = JsonlJournal(journal_path)
    entry = app.state.registry.create(run_id, graph, journal, agent=req.agent)

    def journal_and_publish(record: dict) -> None:
        journal.append(record)
        app.state.registry.publish(run_id, record)

    dispatch = app.state.dispatcher_factory(intent, budget, req.agent)
    orchestrator = Orchestrator(intent, budget, dispatch, journal_and_publish)
    entry.task = asyncio.create_task(orchestrator.run(graph))
    return {"run_id": run_id}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_service_start_run.py -v`
Expected: 1 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/service/app.py deemsvc/tests/test_service_start_run.py
git commit -m "feat(deemsvc): add POST /runs to start an orchestrator run"
```

---

### Task 4: GET /runs/{id}/events — SSE journal stream

**Files:**
- Modify: `deemsvc/src/deemsvc/service/app.py`
- Create: `deemsvc/tests/test_service_events_stream.py`

**Interfaces:**
- Consumes: `RunRegistry.subscribe`/`publish`/`unsubscribe` from Task 2.
- Produces: `GET /runs/{id}/events` — `text/event-stream`, one `data: <json>\n\n` frame per journal record, replaying existing records before streaming new ones live.

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_service_events_stream.py`:

```python
import asyncio
import json

import pytest
from httpx import ASGITransport, AsyncClient

from deemsvc.orchestrator.stub_dispatch import ScriptedDispatcher
from deemsvc.service.app import app


@pytest.fixture(autouse=True)
def stub_dispatcher_factory():
    original = app.state.dispatcher_factory
    app.state.dispatcher_factory = lambda intent, budget, agent_name: ScriptedDispatcher()
    yield
    app.state.dispatcher_factory = original


@pytest.mark.asyncio
async def test_events_stream_replays_journal_then_closes_after_run_completes(tmp_path):
    app.state.data_dir = str(tmp_path)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        start = await client.post("/runs", json={
            "goal": "g", "acceptance_criteria": [], "baseline_ref": "0" * 40,
            "worktree": str(tmp_path / "wt"), "token_ceiling": 100_000, "max_attempts": 3,
        })
        run_id = start.json()["run_id"]
        entry = app.state.registry.get(run_id)
        await asyncio.wait_for(entry.task, timeout=5)

        events = []
        async with client.stream("GET", f"/runs/{run_id}/events") as resp:
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    events.append(json.loads(line[len("data: "):]))
                if len(events) >= 2:  # BLOCKED->READY, ..., ->PASSED — stop once we've seen some
                    break

    assert len(events) >= 2
    assert events[0]["step"] == "impl"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_service_events_stream.py -v`
Expected: FAIL with `404 Not Found` (no `/runs/{id}/events` route yet — assert on
`resp.status_code == 404` mentally, or just observe the test errors when the stream
context manager gets a 404).

- [ ] **Step 3: Implement GET /runs/{id}/events**

Add to `deemsvc/src/deemsvc/service/app.py` (add `import json` and
`from fastapi import HTTPException` and `from fastapi.responses import StreamingResponse`
to the imports):

```python
import json

from fastapi import HTTPException
from fastapi.responses import StreamingResponse


@app.get("/runs/{run_id}/events")
async def stream_events(run_id: str) -> StreamingResponse:
    entry = app.state.registry.get(run_id)
    if entry is None:
        raise HTTPException(404, "unknown run_id")

    async def gen():
        # Replay what's already on disk first, so a client that connects after
        # the run finished still sees the full history.
        for line in open(entry.journal.path):
            line = line.strip()
            if line:
                yield f"data: {line}\n\n"

        if entry.task is not None and entry.task.done():
            return  # nothing more will ever be published

        queue = app.state.registry.subscribe(run_id)
        try:
            while True:
                record = await queue.get()
                yield f"data: {json.dumps(record, sort_keys=True, default=str)}\n\n"
                if record.get("to") in ("passed", "abandoned", "escalated") and (
                    entry.task is not None and entry.task.done()
                ):
                    break
        finally:
            app.state.registry.unsubscribe(run_id, queue)

    return StreamingResponse(gen(), media_type="text/event-stream")
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_service_events_stream.py -v`
Expected: 1 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/service/app.py deemsvc/tests/test_service_events_stream.py
git commit -m "feat(deemsvc): add SSE run-events stream with journal replay"
```

---

### Task 5: POST /runs/{id}/resume and GET /runs/{id}/state

**Files:**
- Modify: `deemsvc/src/deemsvc/orchestrator/state.py`
- Modify: `deemsvc/src/deemsvc/service/app.py`
- Create: `deemsvc/tests/test_service_resume_state.py`

**Interfaces:**
- Consumes: `Orchestrator`, `StepStatus` from `deemsvc-orchestrator-core`.
- Produces: `Orchestrator.resume_step(step: Step) -> None` (transitions `ESCALATED → READY`), `GET /runs/{id}/state` (→ `{"run_id", "done": bool, "steps": {step_id: {"status", "attempts"}}}`), `POST /runs/{id}/resume` (body `{"step_id": str}` → re-dispatches an escalated step and restarts the orchestrator loop for the remaining graph).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_service_resume_state.py`:

```python
import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from deemsvc.orchestrator.stub_dispatch import ScriptedDispatcher
from deemsvc.service.app import app


@pytest.fixture(autouse=True)
def stub_dispatcher_factory():
    # Always escalates on the first attempt so /resume has something to act on.
    original = app.state.dispatcher_factory
    app.state.dispatcher_factory = lambda intent, budget, agent_name: ScriptedDispatcher(
        script={"impl": ["escalate"]})
    yield
    app.state.dispatcher_factory = original


@pytest.mark.asyncio
async def test_state_reflects_escalation_and_resume_reruns_to_completion(tmp_path):
    app.state.data_dir = str(tmp_path)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        start = await client.post("/runs", json={
            "goal": "g", "acceptance_criteria": [], "baseline_ref": "0" * 40,
            "worktree": str(tmp_path / "wt"), "token_ceiling": 100_000, "max_attempts": 1,
        })
        run_id = start.json()["run_id"]
        entry = app.state.registry.get(run_id)
        await asyncio.wait_for(entry.task, timeout=5)

        state = (await client.get(f"/runs/{run_id}/state")).json()
        assert state["steps"]["impl"]["status"] == "escalated"

        # Swap the script so the next dispatch passes, then resume.
        entry.graph["impl"].payload = entry.graph["impl"].payload  # no-op, for clarity
        app.state.dispatcher_factory = lambda intent, budget, agent_name: ScriptedDispatcher()
        resume = await client.post(f"/runs/{run_id}/resume", json={"step_id": "impl"})
        assert resume.status_code == 200

        final_state = (await client.get(f"/runs/{run_id}/state")).json()
    assert final_state["steps"]["impl"]["status"] == "passed"
    assert final_state["done"] is True
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_service_resume_state.py -v`
Expected: FAIL with `404 Not Found` for `/runs/{id}/state`.

- [ ] **Step 3: Implement resume_step, GET /state, and POST /resume**

Add to `Orchestrator` in `deemsvc/src/deemsvc/orchestrator/state.py`:

```python
    def resume_step(self, step: Step) -> None:
        """The single re-entry point after an ESCALATED step is resolved by a
        human or an orchestrator-level replan (blueprint §7.2: ESCALATED -> READY
        is the only legal escape from escalation other than ABANDONED)."""
        step.attempts = 0
        self._transition(step, StepStatus.READY)
```

Add to `deemsvc/src/deemsvc/service/app.py`:

```python
class ResumeRequest(BaseModel):
    step_id: str


@app.get("/runs/{run_id}/state")
async def get_state(run_id: str) -> dict:
    entry = app.state.registry.get(run_id)
    if entry is None:
        raise HTTPException(404, "unknown run_id")
    return {
        "run_id": run_id,
        "done": entry.task.done() if entry.task else False,
        "steps": {sid: {"status": s.status.value, "attempts": s.attempts}
                 for sid, s in entry.graph.items()},
    }


@app.post("/runs/{run_id}/resume")
async def resume_run(run_id: str, req: ResumeRequest) -> dict:
    entry = app.state.registry.get(run_id)
    if entry is None:
        raise HTTPException(404, "unknown run_id")
    step = entry.graph.get(req.step_id)
    if step is None:
        raise HTTPException(404, "unknown step_id")
    if step.status is not StepStatus.ESCALATED:
        raise HTTPException(409, f"step is {step.status}, not escalated")

    intent = Intent(goal="resumed", acceptance_criteria=(), protected_paths=(),
                    forbidden_actions=(), baseline_ref="0" * 40)
    budget = TokenBudget(ceiling=500_000)
    # Reuse the same agent the run was started with — a resumed escalation
    # shouldn't silently switch backends underneath the operator.
    dispatch = app.state.dispatcher_factory(intent, budget, entry.agent)

    def journal_and_publish(record: dict) -> None:
        entry.journal.append(record)
        app.state.registry.publish(run_id, record)

    orchestrator = Orchestrator(intent, budget, dispatch, journal_and_publish)
    orchestrator.resume_step(step)
    entry.task = asyncio.create_task(orchestrator.run(entry.graph))
    return {"resumed": req.step_id}
```

Add `StepStatus` to the existing `from deemsvc.orchestrator.state import (...)` import
line in `app.py` so it reads
`from deemsvc.orchestrator.state import Intent, Orchestrator, Step, StepStatus, TokenBudget`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_service_resume_state.py -v`
Expected: 1 passed

- [ ] **Step 5: Run the full deemsvc test suite**

Run: `cd deemsvc && .venv/bin/pytest -v`
Expected: every test from all five plans passes together (130+ tests, 0 failures,
live-API tests skipped unless `ANTHROPIC_API_KEY` is set).

- [ ] **Step 6: Commit**

```bash
git add deemsvc/src/deemsvc/orchestrator/state.py deemsvc/src/deemsvc/service/app.py \
        deemsvc/tests/test_service_resume_state.py
git commit -m "feat(deemsvc): add run state snapshot and escalation resume"
```

---

### Task 6: Node supervisor + HTTP/SSE client for deemsvc

**Files:**
- Create: `server/deemsvc-client.js`
- Create: `server/deemsvc-supervisor.js`
- Create: `server/tests/deemsvc-supervisor.test.js`

**Interfaces:**
- Produces (`deemsvc-supervisor.js`): `startDeemsvc({ port }) -> Promise<{ stop: () => void }>` (spawns `deemsvc/.venv/bin/uvicorn`, polls `/health` until ready, restarts with backoff on unexpected exit, `stop()` sends SIGTERM). Produces (`deemsvc-client.js`): `startRun(baseUrl, payload) -> Promise<{ run_id }>`, `streamEvents(baseUrl, runId, onEvent) -> { close: () => void }` (hand-rolled SSE line parser over `node:http`), `getState(baseUrl, runId) -> Promise<object>`, `resumeStep(baseUrl, runId, stepId) -> Promise<object>`.

- [ ] **Step 1: Write the failing test**

`server/tests/deemsvc-supervisor.test.js` (uses Node's built-in test runner, matching
`server/tests/*.test.js`'s existing convention per `package.json`'s
`"test": "node --test server/tests/*.test.js"`):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamEvents, getState } from '../deemsvc-client.js';

// A minimal fake deemsvc HTTP server, so this test never spawns the real
// Python process or depends on network access.
function fakeServer() {
  return http.createServer((req, res) => {
    if (req.url === '/runs/abc/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ run_id: 'abc', done: true, steps: {} }));
      return;
    }
    if (req.url === '/runs/abc/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"step":"impl","to":"ready"}\n\n');
      res.write('data: {"step":"impl","to":"passed"}\n\n');
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

test('getState parses the JSON response body', async () => {
  const server = fakeServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const state = await getState(`http://127.0.0.1:${port}`, 'abc');
  assert.equal(state.run_id, 'abc');
  assert.equal(state.done, true);
  server.close();
});

test('streamEvents delivers each SSE frame as a parsed event, then closes', async () => {
  const server = fakeServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const received = [];
  await new Promise((resolve) => {
    const handle = streamEvents(`http://127.0.0.1:${port}`, 'abc', (event) => {
      received.push(event);
      if (received.length === 2) {
        handle.close();
        resolve();
      }
    });
  });
  assert.deepEqual(received, [
    { step: 'impl', to: 'ready' },
    { step: 'impl', to: 'passed' },
  ]);
  server.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/tests/deemsvc-supervisor.test.js`
Expected: FAIL — `Cannot find module '../deemsvc-client.js'`

- [ ] **Step 3: Implement deemsvc-client.js**

`server/deemsvc-client.js`:

```js
// Thin HTTP/SSE client for the deemsvc Python service. No third-party
// dependencies — Node's built-in http/https cover both plain requests and
// a hand-rolled SSE line parser.
import http from 'node:http';
import https from 'node:https';

function transportFor(url) {
  return url.startsWith('https:') ? https : http;
}

function requestJson(baseUrl, method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body ? JSON.stringify(body) : null;
    const req = transportFor(baseUrl).request(url, {
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`deemsvc ${method} ${path} -> ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(data ? JSON.parse(data) : null);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function startRun(baseUrl, payload) {
  return requestJson(baseUrl, 'POST', '/runs', payload);
}

export function getState(baseUrl, runId) {
  return requestJson(baseUrl, 'GET', `/runs/${runId}/state`);
}

export function resumeStep(baseUrl, runId, stepId) {
  return requestJson(baseUrl, 'POST', `/runs/${runId}/resume`, { step_id: stepId });
}

// Parses `data: <json>\n\n` frames as they arrive and hands each parsed
// object to onEvent. Returns { close } to end the connection early.
export function streamEvents(baseUrl, runId, onEvent) {
  const url = new URL(`/runs/${runId}/events`, baseUrl);
  const req = transportFor(baseUrl).get(url, (res) => {
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try {
            onEvent(JSON.parse(line.slice('data: '.length)));
          } catch {
            /* skip a malformed frame rather than crashing the stream */
          }
        }
      }
    });
  });
  req.on('error', () => { /* caller observes via lack of further events */ });
  return { close: () => req.destroy() };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/tests/deemsvc-supervisor.test.js`
Expected: 2 pass (note: `deemsvc-supervisor.js` doesn't exist yet — Step 5 adds it and
its own tests; this step only proves the client).

- [ ] **Step 5: Implement deemsvc-supervisor.js**

`server/deemsvc-supervisor.js`:

```js
// Spawns and supervises the deemsvc Python service as a managed child
// process — the same spawn()-and-watch shape server/agents/claude.js and
// server/agents/codex.js already use for agent subprocesses.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getState } from './deemsvc-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UVICORN = path.join(__dirname, '..', 'deemsvc', '.venv', 'bin', 'uvicorn');

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export function startDeemsvc({ port = 8731, restartDelayMs = 2000 } = {}) {
  const baseUrl = `http://127.0.0.1:${port}`;
  let child = null;
  let stopped = false;

  function spawnChild() {
    child = spawn(UVICORN, ['deemsvc.service.app:app', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: path.join(__dirname, '..', 'deemsvc'),
      env: process.env,
    });
    child.on('exit', (code, signal) => {
      if (stopped) return;
      console.error(`[deemsvc] exited unexpectedly (code=${code} signal=${signal}) — restarting in ${restartDelayMs}ms`);
      setTimeout(spawnChild, restartDelayMs);
    });
  }

  spawnChild();

  return waitForHealth(baseUrl, 15_000).then((healthy) => {
    if (!healthy) throw new Error('deemsvc did not become healthy within 15s');
    return {
      baseUrl,
      stop() {
        stopped = true;
        if (child) child.kill('SIGTERM');
      },
    };
  });
}
```

- [ ] **Step 6: Run the full Node test suite**

Run: `npm test`
Expected: all existing tests plus `deemsvc-supervisor.test.js` pass.

- [ ] **Step 7: Commit**

```bash
git add server/deemsvc-client.js server/deemsvc-supervisor.js server/tests/deemsvc-supervisor.test.js
git commit -m "feat(server): add deemsvc process supervisor and HTTP/SSE client"
```

---

### Task 7: Journal-to-store projector

**Files:**
- Create: `server/deemsvc-projector.js`
- Create: `server/tests/deemsvc-projector.test.js`

**Interfaces:**
- Consumes: `db` from `server/store.js`, `broadcast` from `server/events.js`, `PHASES`, `phaseRecord` from `server/workflow.js`.
- Produces: `projectEvent(taskId, record) -> void` — maps a deemsvc journal record (`{step, from, to, ...}`) onto the task's `execution` phase (per this plan's single-step scope, §Global Constraints) and broadcasts it, following the shape `server/monitor.js` already uses for `activity`/`log` events.

- [ ] **Step 1: Write the failing test**

`server/tests/deemsvc-projector.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../store.js';
import { ensurePhases, phaseRecord } from '../workflow.js';
import { projectEvent } from '../deemsvc-projector.js';

test('a READY transition marks the execution phase running', () => {
  const state = db.get();
  state.tasks.push({ id: 't1', projectId: 'p1' });
  ensurePhases('t1');

  projectEvent('t1', { step: 'impl', from: 'blocked', to: 'ready' });
  projectEvent('t1', { step: 'impl', from: 'ready', to: 'dispatched' });
  projectEvent('t1', { step: 'impl', from: 'dispatched', to: 'executing' });

  const rec = phaseRecord('t1', 'execution');
  assert.equal(rec.status, 'running');
  assert.ok(rec.startedAt);
});

test('a PASSED transition marks the execution phase passed with finishedAt set', () => {
  const state = db.get();
  state.tasks.push({ id: 't2', projectId: 'p1' });
  ensurePhases('t2');

  projectEvent('t2', { step: 'impl', from: 'dispatched', to: 'executing' });
  projectEvent('t2', { step: 'impl', from: 'verifying', to: 'passed' });

  const rec = phaseRecord('t2', 'execution');
  assert.equal(rec.status, 'passed');
  assert.ok(rec.finishedAt);
});

test('an ESCALATED transition marks the execution phase failed with the reason in error', () => {
  const state = db.get();
  state.tasks.push({ id: 't3', projectId: 'p1' });
  ensurePhases('t3');

  projectEvent('t3', { step: 'impl', from: 'verifying', to: 'escalated' });

  const rec = phaseRecord('t3', 'execution');
  assert.equal(rec.status, 'failed');
  assert.ok(rec.error);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/tests/deemsvc-projector.test.js`
Expected: FAIL — `Cannot find module '../deemsvc-projector.js'`

- [ ] **Step 3: Implement projectEvent**

`server/deemsvc-projector.js`:

```js
// Maps deemsvc JSONL journal records onto the existing task/phase shape in
// data/deem.json, so every current UI tab renders unchanged. Per this plan's
// scope (a single "generate" step per run), every record is projected onto
// the task's "execution" phase; a multi-step DAG (future work) will project
// onto multiple phases instead.
import { db } from './store.js';
import { broadcast } from './events.js';
import { phaseRecord } from './workflow.js';

const RUNNING_STATUSES = new Set(['ready', 'dispatched', 'executing', 'verifying', 'retrying']);
const TERMINAL_STATUS = { passed: 'passed', escalated: 'failed', abandoned: 'failed' };

export function projectEvent(taskId, record) {
  const rec = phaseRecord(taskId, 'execution');
  if (!rec) return; // task predates deemsvc phases, or isn't tracked here

  if (RUNNING_STATUSES.has(record.to) && rec.status !== 'running') {
    rec.status = 'running';
    rec.startedAt = rec.startedAt || Date.now();
  } else if (record.to in TERMINAL_STATUS) {
    rec.status = TERMINAL_STATUS[record.to];
    rec.finishedAt = Date.now();
    if (record.to !== 'passed') {
      rec.error = `deemsvc: step ${record.step} -> ${record.to}`;
    }
  }
  db.save();
  broadcast('phase', { taskId, phase: 'execution', record: rec });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/tests/deemsvc-projector.test.js`
Expected: 3 pass

- [ ] **Step 5: Commit**

```bash
git add server/deemsvc-projector.js server/tests/deemsvc-projector.test.js
git commit -m "feat(server): project deemsvc journal events onto the execution phase"
```

---

### Task 8: Wire into server boot, add the deemsvc-backed agent options, manual verification

**Files:**
- Modify: `server/index.js:1-32`
- Modify: `server/agents/index.js`
- Modify: `web/src/pages/Project.jsx:138-143`
- Modify: `docs/PRODUCTION.md`

**Interfaces:**
- Consumes: `startDeemsvc` (Task 6), `streamEvents`/`startRun`/`getState`/`resumeStep` (Task 6), `projectEvent` (Task 7).
- Produces: no new exported interface — this task is pure wiring plus a UI addition, verified manually since it spans a live dev server and a browser.

**Naming note:** deemsvc's registry (`deemsvc-fable5-dispatcher` Task 7) names its
adapters `fable5-native`, `claude-code-cli`, `codex-cli`. These are deliberately
distinct from the existing `claude-code`/`codex` values already used by
`server/agents/{claude,codex}.js` (the old `workflow.js`-backed engine) — same
underlying CLI tools, two different execution paths during the shadow-run period.
A project's `agent` field, whichever value it holds, is what's forwarded verbatim as
`POST /runs`' `agent` field; no per-agent branching lives in Node.

- [ ] **Step 1: Add the agent labels**

In `server/agents/index.js`, add three new entries to the existing `AGENT_LABELS` map
(the route-independent adapters map, `AGENTS`, is intentionally left untouched — none
of the three new engine options are dispatched through `getAgent()`):

```js
export const AGENT_LABELS = {
  mock: 'MOCK RUNNER',
  'claude-code': 'CLAUDE CODE',
  codex: 'CODEX',
  'fable5-native': 'FABLE 5 (NATIVE)',
  'claude-code-cli': 'CLAUDE CODE (DEEMSVC)',
  'codex-cli': 'CODEX (DEEMSVC)',
};

// Every value the "Fable 5 (native)" project setting can take routes through
// deemsvc's POST /runs `agent` field unchanged — see server/index.js's
// /api/tasks/:id/run-deemsvc route.
export const DEEMSVC_AGENTS = new Set(['fable5-native', 'claude-code-cli', 'codex-cli']);
```

- [ ] **Step 2: Boot deemsvc alongside the API server**

In `server/index.js`, add the import (after the existing `telegram.js` import on line
17) and the boot call (after `app.use('/api', authMiddleware);` on line 22):

```js
import { startDeemsvc } from './deemsvc-supervisor.js';
import { startRun, streamEvents, getState, resumeStep } from './deemsvc-client.js';
import { projectEvent } from './deemsvc-projector.js';
import { DEEMSVC_AGENTS } from './agents/index.js';
```

```js
let deemsvc = null;
try {
  deemsvc = await startDeemsvc({ port: 8731 });
  console.log(`[deemsvc] ready at ${deemsvc.baseUrl}`);
} catch (err) {
  console.error(`[deemsvc] failed to start — deemsvc-backed agent options will error until this is fixed: ${err.message}`);
}
```

- [ ] **Step 3: Add a route to start a deemsvc-backed task run for any registered agent**

Add to `server/index.js`, near the other task-mutating routes (this plan does not
replicate the full `/api/tasks/:id/start`-style routing already used by
`workflow.js`-backed tasks — it adds a parallel, minimal route scoped to this plan's
single-step graph, generic over which deemsvc agent the project selected):

```js
app.post('/api/tasks/:id/run-deemsvc', async (req, res) => {
  if (!deemsvc) return res.status(503).json({ error: 'deemsvc is not running' });
  const t = findTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  const p = findProject(t.projectId);
  if (!DEEMSVC_AGENTS.has(p.agent)) {
    return res.status(400).json({ error: `project agent "${p.agent}" is not a deemsvc backend` });
  }

  const { run_id } = await startRun(deemsvc.baseUrl, {
    goal: t.description,
    acceptance_criteria: t.requirements || [],
    baseline_ref: req.body.baselineRef,
    worktree: req.body.worktreePath,
    token_ceiling: state().settings.defaultTokenBudget,
    max_attempts: 4,
    agent: p.agent,
  });

  streamEvents(deemsvc.baseUrl, run_id, (record) => projectEvent(t.id, record));
  res.json({ runId: run_id });
});

app.get('/api/tasks/:id/deemsvc-state/:runId', async (req, res) => {
  if (!deemsvc) return res.status(503).json({ error: 'deemsvc is not running' });
  res.json(await getState(deemsvc.baseUrl, req.params.runId));
});

app.post('/api/tasks/:id/deemsvc-resume/:runId', async (req, res) => {
  if (!deemsvc) return res.status(503).json({ error: 'deemsvc is not running' });
  res.json(await resumeStep(deemsvc.baseUrl, req.params.runId, req.body.stepId));
});
```

- [ ] **Step 4: Add the agent options to project settings**

In `web/src/pages/Project.jsx`, extend the `<select>` at lines 139-143:

```jsx
<select className="text" value={form.agent} onChange={set('agent')}>
  <option value="mock">Mock runner (no API cost)</option>
  <option value="claude-code">Claude Code</option>
  <option value="codex">Codex</option>
  <option value="fable5-native">Fable 5 (native)</option>
  <option value="claude-code-cli">Claude Code (deemsvc)</option>
  <option value="codex-cli">Codex (deemsvc)</option>
</select>
```

- [ ] **Step 5: Manual verification — start the dev server and drive the option in a browser**

Run: `npm run dev` (starts the API on :4501 and the web app on :4500).

In a browser (or via the preview tools if available in this environment):
1. Navigate to `http://localhost:4500`, create an account, add a project pointing at
   any local git repository, and select **Fable 5 (native)** as the agent.
2. Confirm the option is selectable and saves — reload the project settings page and
   verify "Fable 5 (native)" is still selected.
3. Check the server log for `[deemsvc] ready at http://127.0.0.1:8731` on startup —
   if it instead logs `[deemsvc] failed to start`, stop here and fix the supervisor
   before continuing (likely cause: `deemsvc/.venv` wasn't created — rerun
   `cd deemsvc && python3.11 -m venv .venv && .venv/bin/pip install -e ".[dev]"`).
4. With `ANTHROPIC_API_KEY` set in the environment, use `curl` to exercise the new
   route end to end against a scratch git repo:
   ```bash
   curl -s -X POST http://localhost:4501/api/tasks/<taskId>/run-deemsvc \
     -H 'Content-Type: application/json' \
     -H "Cookie: $(cat /tmp/deem-session-cookie)" \
     -d '{"baselineRef": "<sha>", "worktreePath": "/path/to/a/throwaway/worktree"}'
   ```
   and confirm a `runId` comes back, and that the task's Execution tab in the browser
   updates to "running" and eventually "passed" or "failed" without a page reload
   (the SSE relay through `projectEvent` should make this visible live).
5. Repeat step 4 with the project's agent switched to **Claude Code (deemsvc)** and
   then **Codex (deemsvc)** — these require the `claude`/`codex` CLIs installed and
   authenticated on the host, same as the existing `claude-code`/`codex` options. The
   route and request shape are identical; only `p.agent`'s value changes. Confirm each
   selects the right adapter by checking the run's evidence in `GET
   /api/tasks/:id/deemsvc-state/:runId` — the response's step evidence should show
   `"cli": "claude-code-cli"` or `"cli": "codex-cli"` for those two, and no `cli` key
   for `fable5-native`.

- [ ] **Step 6: Document the platform gap and the new least-privilege model**

Per `docs/specs/2026-07-12-fable5-engine-rebuild-design.md` §6, add a new point to
`docs/PRODUCTION.md`'s "The safety model" section (after the existing point "3. Agents
run with least privilege by default." and before point "4. Every claim is verified..."
— renumber the existing point 4 to point 5):

```markdown
**4. deemsvc-backed agents run in a POSIX sandbox — macOS/Linux only.**
Every deemsvc agent option (Fable 5 native, Claude Code (deemsvc), Codex (deemsvc))
shares one tool broker that confines every tool invocation with `setrlimit` (CPU,
memory, file descriptors, file size) and kills timed-out processes by process group
(`SIGKILL` the whole group, not just the parent). This is enforced by the broker,
not by agent instructions — a prompt cannot talk its way past it, and it applies
uniformly whether the candidate came from the Anthropic API or a CLI subprocess. It
does not run on Windows: the `resource` module `deemsvc` depends on is POSIX-only.
Windows support is a known gap, not yet built; use the original Mock, Claude Code,
or Codex options (not their "(deemsvc)" counterparts) on Windows until it lands. The
"(deemsvc)" CLI options additionally require the `claude`/`codex` CLI installed and
authenticated, same as their non-deemsvc counterparts — deemsvc doesn't bundle them.
```

- [ ] **Step 7: Commit**

```bash
git add server/index.js server/agents/index.js web/src/pages/Project.jsx docs/PRODUCTION.md
git commit -m "feat: wire deemsvc into server boot and add the deemsvc-backed agent options"
```
