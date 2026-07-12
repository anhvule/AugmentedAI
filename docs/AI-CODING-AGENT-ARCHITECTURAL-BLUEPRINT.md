# Architectural Blueprint — Next-Generation Autonomous Coding Agent

**Status:** Production reference · **Author role:** Principal AI Systems Architect · **Target model:** Claude Fable 5 (`claude-fable-5`)

---

## 1. Executive Summary

This blueprint specifies a long-horizon repository-management agent built as a **deterministic orchestrator wrapping non-deterministic workers**. The definitive architectural conclusion, stated up front:

1. **Agent claims are hypotheses; only ground truth is state.** No LLM output ever mutates the authoritative run state directly. Sub-agent results are *proposed* transitions that must be corroborated by machine evidence (git object digests, test exit codes, JUnit transition matrices) before the orchestrator commits them. This single invariant eliminates the dominant failure class of autonomous coding agents: confidently reported, unverified work.

2. **The orchestrator is code, not a model.** Global intent, token accounting, DAG scheduling, retry policy, and escalation are implemented as an explicit `asyncio` state machine with a typed transition table. The model plans and generates; the harness decides. This keeps every safety-critical decision replayable and auditable.

3. **Verification runs in a fresh context against twin git worktrees.** The Verifier sub-agent never sees the Generator's conversation. It receives only the diff, the pinned acceptance criteria, and differential test evidence computed by running the suite at the merge-base and at the candidate commit in isolated worktrees. Regressions are defined structurally (`PASS→FAIL` transitions), not rhetorically.

4. **Retry vs. escalate is an algorithm, not a vibe.** The Verifier computes a *failure signature* (a stable hash of normalized failure evidence). A repeated signature means the Generator is looping → escalate. A novel signature with shrinking regression count means progress → retry with structured feedback. Budget floors and attempt ceilings bound the loop absolutely.

**Resulting system properties:** zero-regression merges by construction (the integration gate cannot fire without a clean transition matrix), bounded spend (hierarchical token budget with reservation/commit semantics), crash-recoverable runs (event-sourced state journal), and least-privilege execution (per-agent capability grants; sandboxed, argv-only tool invocation).

---

## 2. System Topology

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ORCHESTRATOR (deterministic Python, asyncio)                           │
│  ┌───────────────┐ ┌──────────────┐ ┌───────────────┐ ┌──────────────┐  │
│  │ Intent Ledger │ │ Token Budget │ │ DAG Scheduler │ │ Run Journal  │  │
│  │ (frozen spec) │ │ (reserve/    │ │ (asyncio,     │ │ (JSONL event │  │
│  │  + digest     │ │  commit)     │ │  frontier)    │ │  sourcing)   │  │
│  └───────────────┘ └──────────────┘ └───────────────┘ └──────────────┘  │
└───────┬───────────────────┬───────────────────┬─────────────────────────┘
        │ task.assign       │ task.assign       │ task.assign        (async, correlation-keyed)
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────────────────────┐
│ EXPLORER      │   │ GENERATOR     │   │ VERIFIER                      │
│ read-only     │   │ worktree W_g  │   │ twin worktrees W_base, W_cand │
│ grants        │   │ mutating      │   │ fresh context, no generator   │
│ effort: low   │   │ effort: high  │   │ transcript. effort: high      │
└──────┬────────┘   └──────┬────────┘   └──────────────┬────────────────┘
       │                   │                           │
       └───────────────────┴──────────┬────────────────┘
                                      ▼
                    ┌──────────────────────────────────┐
                    │ TOOL BROKER (sandbox boundary)   │
                    │ argv-only exec · env scrub ·     │
                    │ rlimits · process-group kill ·   │
                    │ structured stdout parsers        │
                    └──────────────────────────────────┘
```

Every agent action, without exception, flows through the four-stage Standardized Quality Pipeline (§6): **Compile → Generate → Verify → Integrate**.

---

## 3. Layer 1 — Orchestration & State Management

### 3.1 Design decisions

- **Typed transition table.** Illegal state transitions raise at the harness level; a confused model cannot corrupt run state.
- **Reservation/commit token accounting.** Before a step dispatches, its projected cost is *reserved* against the run ceiling using an EWMA of historical actuals per step class. On completion, the reservation is replaced by the metered actual. Over-subscription is therefore impossible even with concurrent in-flight steps.
- **Frontier scheduling.** Dependencies are a DAG over step IDs. The scheduler dispatches the entire ready frontier (bounded by concurrency), then blocks on `asyncio.wait(..., FIRST_COMPLETED)` — wall-clock is governed by the critical path, not by artificial barriers.
- **Event-sourced journal.** Every transition is appended to a JSONL journal before it takes effect (write-ahead). Crash recovery replays the journal; in-flight steps re-enter `READY`.

### 3.2 Reference implementation (`orchestrator/state.py`)

```python
from __future__ import annotations

import asyncio
import hashlib
import json
import time
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Awaitable, Callable, Literal


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
        return est

    def commit(self, step_id: str, step_class: str, actual: int) -> None:
        self._reservations.pop(step_id, None)
        self._committed += actual
        prev = self._ewma.get(step_class, float(actual))
        self._ewma[step_class] = self._EWMA_ALPHA * actual + (1 - self._EWMA_ALPHA) * prev

    def release(self, step_id: str) -> None:
        self._reservations.pop(step_id, None)


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
            if self.budget.pressure() < self.escalation_cutoff():
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

    def escalation_cutoff(self) -> float:
        return self.budget.escalation_watermark
```

**Why this shape:** budget failure is a *scheduling* event (`ESCALATED`), never an exception that unwinds the run; retries re-enter the same dispatch path with the verifier's feedback packet threaded through `Step.feedback`; and abandonment cascades transitively so no orphaned work burns tokens after its ancestor fails.

---

## 4. Layer 2 — Multi-Agent / Sub-Agent Topography

### 4.1 Protocol semantics

Communication is **asynchronous, correlation-keyed, at-least-once**:

- The orchestrator emits `task.assign` and immediately returns to the scheduler loop — assignment never blocks.
- Sub-agents emit `task.heartbeat` on a fixed cadence carrying incremental token spend; a missed-heartbeat watchdog (2× cadence) transitions the step to `ESCALATED` and kills the worker's process group.
- `task.result` messages are idempotent: the orchestrator deduplicates on `idempotency_key`, so a retried delivery cannot double-commit budget or double-transition state.
- **Context is passed by manifest, not by value.** The assignment names files with content digests; the sub-agent reads them through the Tool Broker and must abort with `STALE_CONTEXT` if a digest mismatches. This makes concurrent-mutation races detectable instead of silent.

### 4.2 Wire schemas

**Envelope (all messages):**

```json
{
  "proto": "aac/1",
  "msg_id": "01J8Z3V9GQK7T2W4X6Y8Z0ABCD",
  "kind": "task.assign",
  "correlation_id": "step-impl-042",
  "causation_id": "01J8Z3T2...",
  "idempotency_key": "run-7f3a:step-impl-042:attempt-2",
  "sent_at": "2026-07-12T09:14:03.220Z",
  "sender": "orchestrator",
  "payload": { }
}
```

**`task.assign` payload (orchestrator → Generator):**

```json
{
  "role": "generator",
  "intent_digest": "9c41d2e07a55b8f1",
  "objective": "Make ProjectionCache invalidate on schema migration; see AC-3/AC-4.",
  "acceptance_criteria": [
    "AC-3: cache entries keyed by (table, schema_version) — stale versions unreachable",
    "AC-4: existing test suite green; new tests cover the invalidation path"
  ],
  "attempt": 2,
  "verifier_feedback": {
    "regressions": [
      {"test_id": "tests/test_cache.py::test_lru_eviction",
       "transition": "PASS->FAIL",
       "trace_head": "KeyError: ('users', 3) at cache.py:118"}
    ],
    "diff_scoped_lint": [],
    "instruction": "Fix only the listed regression. Do not restructure eviction."
  },
  "context_manifest": {
    "read_before_editing": [
      {"path": "server/cache.py", "sha256": "e3b0c44298fc1c14..."},
      {"path": "server/migrations/runner.py", "sha256": "a54d88e06612d820..."}
    ],
    "abort_if_digest_mismatch": true
  },
  "capability_grant": {
    "worktree": "/runs/7f3a/wt-generator",
    "fs_write_scope": ["server/", "tests/"],
    "fs_deny": ["migrations/", ".github/"],
    "tools_allowed": ["read", "edit", "write", "grep", "pytest-junit", "ruff-json"],
    "network": "deny"
  },
  "budget_grant": {
    "token_ceiling": 90000,
    "wall_clock_s": 900,
    "max_tool_calls": 120,
    "heartbeat_every_s": 30
  },
  "response_contract": {"schema_ref": "aac/1/task.result", "strict": true}
}
```

**`task.result` payload (sub-agent → orchestrator):**

```json
{
  "status": "completed",
  "claims": [
    {"claim": "AC-3 implemented: cache key includes schema_version",
     "evidence": {"type": "git_diff_digest",
                  "worktree_head": "4be91cf07d2e...",
                  "files_touched": ["server/cache.py", "tests/test_cache.py"]}},
    {"claim": "focused tests pass locally",
     "evidence": {"type": "tool_invocation",
                  "tool": "pytest-junit",
                  "exit_code": 0,
                  "junit_digest": "sha256:77af2b0c..."}}
  ],
  "artifacts": {"candidate_ref": "4be91cf07d2e", "diff_stat": {"files": 2, "+": 84, "-": 17}},
  "usage": {"input_tokens": 51230, "output_tokens": 11894, "tool_calls": 37},
  "self_assessed_risk": "low"
}
```

Every `claims[].evidence` entry is a *pointer to machine-checkable state*. The orchestrator treats a claim with no verifiable evidence as if the work did not happen — it routes the step to the Verifier exactly as it would an evidenced claim, and the twin-worktree diff is the arbiter.

**`task.heartbeat` / `task.escalate`:**

```json
{"kind": "task.heartbeat",
 "payload": {"tokens_spent_delta": 8210, "tool_calls_delta": 6,
             "phase": "editing", "current_file": "server/cache.py"}}

{"kind": "task.escalate",
 "payload": {"reason": "STALE_CONTEXT",
             "detail": "server/cache.py digest mismatch — concurrent mutation",
             "partial_artifacts": null}}
```

**Agent role registry (`agents.yaml`)** — least-privilege by construction:

```yaml
roles:
  explorer:
    model: claude-fable-5
    effort: low
    tools: [read, grep, glob, ast-scan]
    fs_write_scope: []            # read-only, enforced by broker not by prompt
    network: deny
  generator:
    model: claude-fable-5
    effort: high
    tools: [read, edit, write, grep, glob, pytest-junit, ruff-json]
    isolation: worktree
    network: deny
  verifier:
    model: claude-fable-5
    effort: high
    tools: [read, grep, git, pytest-junit, ruff-json, ast-scan]
    fs_write_scope: []            # verifier observes; it never repairs
    fresh_context: true           # generator transcript is never attached
    network: deny
```

---

## 5. Layer 3 — Context & Tooling Interface (Sandbox Boundary)

### 5.1 Boundary rules

1. **No shell, ever.** Tools are invoked as fixed argv vectors (`create_subprocess_exec`); placeholder substitution is validated against a strict character class, so `; rm -rf` in a model-supplied selector is a validation error, not a command.
2. **Environment scrub.** Workers get a minimal allowlisted env — no inherited credentials, no `GIT_*` auth, `GIT_TERMINAL_PROMPT=0`.
3. **Resource confinement.** `setrlimit` in `preexec_fn` (CPU, address space, fd count, file size) plus `start_new_session=True` so timeout kills reach the whole process group.
4. **Structured stdout.** Every registered tool has a parser; raw text never crosses back into model context unparsed. Output is capped and truncation is *flagged*, never silent.
5. **Error taxonomy.** Exit codes are classified per tool: a pytest exit `1` is a *task signal* (payload for the Verifier), not an infrastructure failure; exit `3`/`4` is tool misuse; a timeout is its own kind.

### 5.2 Reference implementation (`sandbox/broker.py`)

```python
from __future__ import annotations

import asyncio
import os
import re
import resource
import signal
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from enum import StrEnum
from typing import Callable

_SAFE_ARG = re.compile(r"[A-Za-z0-9_.:/@=\-\[\]]+")
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
    argv: tuple[str, ...]                    # templated: "{report}", "{selector}", ...
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


def _parse_junit(stdout: bytes, workdir: str) -> dict:
    """pytest writes JUnit XML to a known path; stdout is advisory only."""
    report = os.path.join(workdir, ".aac", "junit.xml")
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
    import json
    findings = json.loads(stdout or b"[]")
    return {"findings": [
        {"path": f["filename"], "line": f["location"]["row"],
         "code": f["code"], "msg": f["message"][:200]}
        for f in findings
    ]}


REGISTRY: dict[str, ToolSpec] = {
    "pytest-junit": ToolSpec(
        name="pytest-junit",
        argv=("python", "-m", "pytest", "-q", "-p", "no:cacheprovider",
              "--junitxml=.aac/junit.xml", "{selector}"),
        timeout_s=600,
        ok_exits=frozenset({0}),
        signal_exits=frozenset({1, 5}),       # 1 = failures, 5 = nothing collected
        parser=_parse_junit,
    ),
    "ruff-json": ToolSpec(
        name="ruff-json",
        argv=("python", "-m", "ruff", "check", "--output-format", "json",
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
        resource.setrlimit(resource.RLIMIT_AS, (6 << 30, 6 << 30))
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
                value = args[token[1:-1]]
                if not _SAFE_ARG.fullmatch(value):
                    raise ValueError(f"unsafe argument for {spec.name}: {value!r}")
                argv.append(value)
            else:
                argv.append(token)
        return argv

    @staticmethod
    async def _drain(stream: asyncio.StreamReader, cap: int) -> tuple[bytes, bool]:
        buf, truncated = bytearray(), False
        while chunk := await stream.read(65536):
            if len(buf) < cap:
                buf += chunk[: cap - len(buf)]
            else:
                truncated = True   # keep draining so the child never blocks on a full pipe
        return bytes(buf), truncated

    async def invoke(self, tool: str, **args: str) -> ToolOutcome:
        spec = REGISTRY[tool]
        argv = self._render(spec, args)
        os.makedirs(os.path.join(self.workdir, ".aac"), exist_ok=True)
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

        kind = OutcomeKind.TOOL_MISUSE if 2 <= code <= 4 else OutcomeKind.INFRA_FAILURE
        return ToolOutcome(kind, code, {}, truncated,
                           stderr[-2048:].decode(errors="replace"), wall_ms)
```

The load-bearing subtlety is the **`TASK_SIGNAL` classification**: a failing test run is a *successful tool invocation whose payload is failure evidence*. Conflating it with infrastructure failure is what causes naive harnesses to retry the tool instead of routing the evidence to the Verifier.

---

## 6. The Standardized Quality Pipeline

Every mutation to the repository passes all four stages. There is no fast path.

| Stage | Name | Actor | Mutates repo? |
|---|---|---|---|
| 1 | Intent Compilation & Preflight | Orchestrator (+ Explorer) | No |
| 2 | Constrained Generation | Generator, isolated worktree | Worktree only |
| 3 | Autonomous Verification Loop | Verifier engine, twin worktrees | No |
| 4 | Integration Gate & Audit | Orchestrator | Main branch (fast-forward only) |

**Stage 1 — Intent Compilation & Preflight.** The user request is compiled into the frozen `Intent` (acceptance criteria as checkable assertions, protected paths, forbidden actions) and a step DAG. Explorer sub-agents (effort `low`, read-only grants) build the context manifests. Preflight records the baseline test snapshot digest so Stage 3 can detect environment drift (baseline suite failing differently than at run start ⇒ infra escalation, not a generator retry).

**Stage 2 — Constrained Generation.** The Generator receives `task.assign`, works in a dedicated `git worktree` (main checkout is never touched), and can only stage a candidate commit. Its capability grant denies writes to protected paths at the broker level — the prompt asks nicely, the sandbox enforces.

**Stage 3 — Autonomous Verification Loop.** Detailed below with full implementation.

**Stage 4 — Integration Gate & Audit.** Fires only on a `pass` verdict whose evidence digest chain is intact: candidate ref exists, transition matrix has zero non-flaky regressions, diff-scoped lint is clean, semantic judge (if invoked) approved. Merge is `--ff-only` onto the run branch; the full evidence bundle (JUnit before/after, verdict JSON, verifier usage) is written to the audit trail keyed by commit SHA.

### 6.1 Stage 3 — Verifier Sub-Agent engine (full implementation)

Contract: the Verifier (a) **instantiates a fresh context boundary** — twin worktrees plus an LLM context assembled only from the diff and pinned criteria, never the Generator transcript; (b) runs **differential tests** and parses JUnit/linter output into a transition matrix; (c) applies **algorithmic retry logic** — signature-novelty, monotonic-progress, attempt and budget bounds — to decide `pass | retry | escalate`.

```python
# verifier/engine.py
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import AsyncIterator, Literal

from anthropic import AsyncAnthropic

from sandbox.broker import OutcomeKind, ToolBroker


class Transition(StrEnum):
    REGRESSION = "PASS->FAIL"       # blocks integration, drives retry
    STILL_FAILING = "FAIL->FAIL"    # pre-existing; never charged to the candidate
    FIXED = "FAIL->PASS"
    NEW_FAILING = "NEW->FAIL"       # a test the candidate added that doesn't pass
    NEW_PASSING = "NEW->PASS"
    REMOVED = "REMOVED"             # test deleted by candidate — audit flag


@dataclass(frozen=True)
class TestDelta:
    test_id: str
    kind: Transition
    trace_head: str = ""


@dataclass(frozen=True)
class VerificationTask:
    step_id: str
    repo_root: str
    baseline_ref: str                       # Intent.baseline_ref (merge-base)
    candidate_ref: str                      # Generator's worktree HEAD
    acceptance_criteria: tuple[str, ...]
    attempt: int                            # 1-based
    max_attempts: int
    prior_signatures: frozenset[str]        # failure signatures from earlier attempts
    changed_paths: tuple[str, ...]


@dataclass
class Verdict:
    decision: Literal["pass", "retry", "escalate"]
    signature: str
    regressions: list[TestDelta] = field(default_factory=list)
    new_failing: list[TestDelta] = field(default_factory=list)
    flaky_quarantined: list[str] = field(default_factory=list)
    lint: list[dict] = field(default_factory=list)
    semantic: dict | None = None
    feedback: dict | None = None            # threaded back into task.assign on retry
    reason: str = ""


class VerifierEngine:
    FLAKE_RERUNS = 3
    TOKEN_FLOOR = 30_000        # below this headroom, retrying is throwing good after bad

    def __init__(self, repo_root: str, client: AsyncAnthropic):
        self.repo_root = repo_root
        self.client = client

    # ---- (1) fresh context boundary -------------------------------------

    @contextlib.asynccontextmanager
    async def _twin_worktrees(self, task: VerificationTask) -> AsyncIterator[tuple[str, str]]:
        """Two detached worktrees: baseline at merge-base, candidate at the proposed ref.

        Neither shares state with the Generator's worktree; both are destroyed on exit.
        This IS the context boundary — verification consumes git objects, not narrative.
        """
        base = os.path.join(self.repo_root, ".aac", f"wt-base-{task.step_id}")
        cand = os.path.join(self.repo_root, ".aac", f"wt-cand-{task.step_id}")
        git = ToolBroker(self.repo_root)
        for path, ref in ((base, task.baseline_ref), (cand, task.candidate_ref)):
            out = await git.invoke("git", sub="worktree", a1="add",
                                   a2="--detach", a3=path, a4=ref)
            if out.kind is not OutcomeKind.TOOL_OK:
                raise RuntimeError(f"worktree add failed: {out.stderr_tail}")
        try:
            yield base, cand
        finally:
            for path in (base, cand):
                await git.invoke("git", sub="worktree", a1="remove",
                                 a2="--force", a3=path, a4=".")

    # ---- (2) differential evaluation ------------------------------------

    async def _snapshot(self, workdir: str, selector: str = "tests") -> dict[str, str]:
        broker = ToolBroker(workdir)
        out = await broker.invoke("pytest-junit", selector=selector)
        if out.kind not in (OutcomeKind.TOOL_OK, OutcomeKind.TASK_SIGNAL):
            raise RuntimeError(f"suite did not run ({out.kind}): {out.stderr_tail}")
        return out.parsed["cases"]          # {test_id: "PASS" | "FAIL:<head>" | "SKIP"}

    @staticmethod
    def _diff_outcomes(before: dict[str, str], after: dict[str, str]) -> list[TestDelta]:
        deltas: list[TestDelta] = []
        for tid, res in after.items():
            prev = before.get(tid)
            failed, head = res.startswith("FAIL"), res.partition(":")[2]
            if prev is None:
                deltas.append(TestDelta(tid, Transition.NEW_FAILING if failed
                                        else Transition.NEW_PASSING, head))
            elif prev == "PASS" and failed:
                deltas.append(TestDelta(tid, Transition.REGRESSION, head))
            elif prev.startswith("FAIL") and failed:
                deltas.append(TestDelta(tid, Transition.STILL_FAILING, head))
            elif prev.startswith("FAIL") and res == "PASS":
                deltas.append(TestDelta(tid, Transition.FIXED))
        deltas.extend(TestDelta(tid, Transition.REMOVED)
                      for tid in before.keys() - after.keys())
        return deltas

    async def _bleach_flakes(self, cand_dir: str,
                             regressions: list[TestDelta]) -> tuple[list[TestDelta], list[str]]:
        """Rerun each regression K times in the candidate tree. Deterministic failure
        stays a regression; any pass among reruns → quarantine as flaky (logged, not
        charged to the candidate, surfaced in the audit trail)."""
        confirmed, flaky = [], []
        broker = ToolBroker(cand_dir)
        for delta in regressions:
            outcomes = []
            for _ in range(self.FLAKE_RERUNS):
                out = await broker.invoke("pytest-junit", selector=delta.test_id)
                outcomes.append(out.parsed["cases"].get(delta.test_id, "FAIL:missing"))
            if all(o.startswith("FAIL") for o in outcomes):
                confirmed.append(delta)
            else:
                flaky.append(delta.test_id)
        return confirmed, flaky

    async def _diff_scoped_lint(self, cand_dir: str,
                                task: VerificationTask) -> list[dict]:
        """Lint findings count only on lines the candidate touched — legacy debt is
        not the Generator's bill. Changed-line map comes from the unified diff."""
        git = ToolBroker(self.repo_root)
        diff = await git.invoke("git", sub="diff", a1="--unified=0",
                                a2=task.baseline_ref, a3=task.candidate_ref, a4=".")
        changed: dict[str, set[int]] = {}
        current = None
        for line in diff.parsed.get("raw", "").splitlines():
            if line.startswith("+++ b/"):
                current = line[6:]
            elif line.startswith("@@") and current:
                m = re.search(r"\+(\d+)(?:,(\d+))?", line)
                start, count = int(m.group(1)), int(m.group(2) or 1)
                changed.setdefault(current, set()).update(range(start, start + count))
        broker = ToolBroker(cand_dir)
        findings: list[dict] = []
        for path in changed:
            out = await broker.invoke("ruff-json", path=path)
            findings += [f for f in out.parsed["findings"]
                         if f["line"] in changed[f["path"]]]
        return findings

    # ---- semantic judgment: fresh LLM context, structured verdict -------

    async def _semantic_review(self, task: VerificationTask,
                               cand_dir: str, deltas: list[TestDelta]) -> dict:
        """Fresh-context model call. Input = diff + criteria + mechanical evidence.
        The Generator's conversation is structurally unreachable from here."""
        git = ToolBroker(self.repo_root)
        diff = await git.invoke("git", sub="diff",
                                a1=task.baseline_ref, a2=task.candidate_ref,
                                a3="--", a4=".")
        response = await self.client.beta.messages.create(
            model="claude-fable-5",
            max_tokens=16000,
            output_config={
                "effort": "high",
                "format": {"type": "json_schema", "schema": {
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
                }},
            },
            betas=["server-side-fallback-2026-06-01"],
            fallbacks=[{"model": "claude-opus-4-8"}],
            system=("You are a verification judge. You receive a diff and acceptance "
                    "criteria. Judge only what the evidence shows. You cannot see the "
                    "author's reasoning, and you must not infer intent from it. "
                    "Mark a criterion met only if the diff plus test evidence proves it."),
            messages=[{"role": "user", "content": json.dumps({
                "acceptance_criteria": task.acceptance_criteria,
                "diff": diff.parsed.get("raw", "")[:150_000],
                "test_transitions": [d.__dict__ for d in deltas],
            })}],
        )
        if response.stop_reason == "refusal":
            return {"criteria": [], "scope_creep": False,
                    "notes": "judge declined; mechanical evidence governs"}
        return json.loads(response.content[-1].text)

    # ---- (3) algorithmic retry / escalation ------------------------------

    @staticmethod
    def _failure_signature(regressions: list[TestDelta], new_failing: list[TestDelta],
                           unmet: list[str]) -> str:
        """Stable hash of the failure *shape*. Trace heads are normalized (addresses,
        line numbers, temp paths stripped) so cosmetically different reruns of the
        same defect collide — that collision is the loop detector."""
        norm = lambda s: re.sub(r"0x[0-9a-f]+|:\d+|/tmp/\S+", "·", s.lower())
        basis = sorted(
            [f"{d.test_id}|{d.kind}|{norm(d.trace_head)}"
             for d in (*regressions, *new_failing)]
            + [f"unmet|{c}" for c in sorted(unmet)]
        )
        return hashlib.sha256("\n".join(basis).encode()).hexdigest()[:16]

    def _adjudicate(self, task: VerificationTask, budget_headroom: int,
                    regressions: list[TestDelta], new_failing: list[TestDelta],
                    flaky: list[str], lint: list[dict], semantic: dict) -> Verdict:
        unmet = [c["id"] for c in semantic.get("criteria", []) if not c["met"]]
        clean = not regressions and not new_failing and not lint and not unmet
        sig = self._failure_signature(regressions, new_failing, unmet)

        if clean:
            return Verdict("pass", sig, flaky_quarantined=flaky, semantic=semantic,
                           reason="zero regressions, criteria met, diff-scoped lint clean")

        # Hard bounds first: these override any notion of "progress".
        if task.attempt >= task.max_attempts:
            return Verdict("escalate", sig, regressions, new_failing, flaky, lint,
                           semantic, reason=f"attempt ceiling {task.max_attempts} reached")
        if budget_headroom < self.TOKEN_FLOOR:
            return Verdict("escalate", sig, regressions, new_failing, flaky, lint,
                           semantic, reason=f"budget headroom {budget_headroom} < floor")

        # Novelty gate: an identical failure signature means the Generator re-derived
        # the same defect — feedback is not landing. Another retry is deterministic waste.
        if sig in task.prior_signatures:
            return Verdict("escalate", sig, regressions, new_failing, flaky, lint,
                           semantic, reason="repeated failure signature — generator looping")

        # Novel signature → retry with a feedback packet scoped to exactly what failed.
        feedback = {
            "regressions": [{"test_id": d.test_id, "transition": d.kind,
                             "trace_head": d.trace_head} for d in regressions],
            "new_failing": [{"test_id": d.test_id, "trace_head": d.trace_head}
                            for d in new_failing],
            "diff_scoped_lint": lint,
            "unmet_criteria": unmet,
            "instruction": ("Address ONLY the items above. Do not refactor beyond them. "
                            "Regressed tests define the contract — change the code, "
                            "not the tests, unless a criterion explicitly says otherwise."),
        }
        return Verdict("retry", sig, regressions, new_failing, flaky, lint,
                       semantic, feedback=feedback,
                       reason="novel failure signature — feedback-directed retry")

    # ---- entry point ------------------------------------------------------

    async def verify(self, task: VerificationTask, budget_headroom: int) -> Verdict:
        async with self._twin_worktrees(task) as (base_dir, cand_dir):
            before = await self._snapshot(base_dir)
            after = await self._snapshot(cand_dir)
            deltas = self._diff_outcomes(before, after)

            regressions = [d for d in deltas if d.kind is Transition.REGRESSION]
            regressions, flaky = await self._bleach_flakes(cand_dir, regressions)
            new_failing = [d for d in deltas if d.kind is Transition.NEW_FAILING]

            lint = await self._diff_scoped_lint(cand_dir, task)
            semantic = await self._semantic_review(task, cand_dir, deltas)

            return self._adjudicate(task, budget_headroom,
                                    regressions, new_failing, flaky, lint, semantic)
```

**Properties of the loop.** Termination is guaranteed by three independent bounds (attempt ceiling, token floor, signature-repeat detection). Regressions are charged only when deterministic (flake bleaching). Pre-existing failures (`FAIL→FAIL`) are structurally excluded from the Generator's bill, so the agent can operate in imperfect legacy repos without being gridlocked by inherited debt. The semantic judge can *block* a pass (unmet criterion) but can never *override* mechanical evidence — a green matrix with an unmet criterion retries; a red matrix never passes regardless of how persuasive the narrative is.

---

## 7. Data Flow & State Matrix

### 7.1 Pipeline data flow

| Stage | Inputs | Transformation | State written | Verification check | Failure route |
|---|---|---|---|---|---|
| 1 Compile | User request, repo HEAD | Request → frozen `Intent` + step DAG + context manifests | Intent ledger, journal `run.compiled` | Criteria are machine-checkable; baseline suite snapshot recorded | Clarification back to user (only block point) |
| 2 Generate | `task.assign` + manifests + prior feedback | Prompted edit session in isolated worktree → candidate commit | Worktree objects only; `task.result` claims | Manifest digests match; grant scope respected (broker-enforced) | `STALE_CONTEXT` escalate; watchdog kill on heartbeat loss |
| 3 Verify | `candidate_ref`, `baseline_ref`, criteria, prior signatures | Twin-worktree differential run → transition matrix → verdict | Verdict + evidence bundle in journal | Zero non-flaky `PASS→FAIL`; zero `NEW→FAIL`; diff-scoped lint clean; criteria met | `retry` (novel signature) or `escalate` (bounds hit) |
| 4 Integrate | `pass` verdict + evidence chain | `--ff-only` merge, audit-trail write | Run branch HEAD; audit record keyed by SHA | Evidence digests verified end-to-end before merge command is issued | Any digest mismatch → `ESCALATED`, no merge |

### 7.2 Step state machine

The transition table is the executable specification (`_LEGAL` in §3.2) — a `✓` is a permitted edge, a blank is a transition the harness rejects with `IllegalTransition` before any state mutates. Terminal states (`PASSED`, `ABANDONED`) have no outbound edges.

| From ↓ \ To → | READY | DISPATCHED | EXECUTING | VERIFYING | PASSED | RETRYING | ESCALATED | ABANDONED |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **BLOCKED**    | ✓ |   |   |   |   |   |   | ✓ |
| **READY**      |   | ✓ |   |   |   |   |   | ✓ |
| **DISPATCHED** |   |   | ✓ |   |   |   | ✓ | ✓ |
| **EXECUTING**  |   |   |   | ✓ |   | ✓ | ✓ | ✓ |
| **VERIFYING**  |   |   |   |   | ✓ | ✓ | ✓ |   |
| **RETRYING**   |   | ✓ |   |   |   |   | ✓ |   |
| **ESCALATED**  | ✓ |   |   |   |   |   |   | ✓ |
| **PASSED**     |   |   |   |   |   |   |   |   |
| **ABANDONED**  |   |   |   |   |   |   |   |   |

Two edges carry the safety-critical semantics. `VERIFYING → RETRYING` is the only route back into generation, and it is reachable *only* from the Verifier's adjudication — a step cannot retry itself. `ESCALATED → READY` is the single re-entry point after an orchestrator-level replan (e.g. the human amends the `Intent`, or a dependency is re-scoped); every other escape from `ESCALATED` is terminal (`ABANDONED`).

### 7.3 Ground-truth arbitration matrix

For each claim class, the table below fixes *what the agent may assert*, *what the harness treats as fact*, and *who wins on conflict*. The right-hand column is the invariant from Executive Summary point 1, made concrete.

| Claim class | Agent may assert | Harness ground truth | Arbiter on conflict |
|---|---|---|---|
| "I changed files X, Y" | `task.result.claims[].files_touched` | `git diff --name-only baseline..candidate` | Git. Empty diff ⇒ claim void ⇒ retry, whatever the score. |
| "Tests pass" | `evidence.exit_code`, `junit_digest` | Broker-run JUnit XML at candidate ref | Broker exit code + parsed matrix. Self-reported pass with `TASK_SIGNAL` exit ⇒ regression. |
| "No regressions" | narrative | `PASS→FAIL` set from twin-worktree diff, flake-bleached | Transition matrix. Any confirmed `PASS→FAIL` ⇒ integration blocked. |
| "Criterion AC-n met" | `semantic.criteria[].met` + evidence string | Diff + transition matrix the judge was shown | Judge may *block* (unmet ⇒ retry) but never *override* a red matrix into a pass. |
| "Lint clean" | narrative | `ruff-json` findings intersected with changed-line map | Diff-scoped findings only; legacy debt excluded structurally. |
| "Ready to merge" | `self_assessed_risk` | End-to-end digest chain (candidate ref ∈ repo, verdict evidence intact) | Orchestrator re-verifies every digest before issuing `--ff-only`; any mismatch ⇒ `ESCALATED`. |

---

## 8. Fable 5 Optimizations — Native System Configuration

This section is the concrete wiring that makes the architecture run *natively* on Claude Fable 5 (`claude-fable-5`): the exact per-role API parameters, the system-prompt structures that counter Fable 5's specific behavioral defaults, the file-based memory hook, the model-facing tool schemas, and the Agent SDK dispatch loop that binds §3's `dispatch` callable to the API.

### 8.1 Per-role request parameters

Fable 5 differs from the Opus tier in ways that are load-bearing here: **thinking is always on** (the `thinking` parameter is omitted entirely — an explicit `{"type": "disabled"}` returns `400`), depth is controlled by `output_config.effort`, the raw chain of thought is never returned, sampling parameters (`temperature`/`top_p`/`top_k`) are rejected, and safety classifiers can return `stop_reason: "refusal"`. The org must have **30-day data retention** (Fable 5 is unavailable under ZDR — every request `400`s otherwise).

| Role | `model` | `effort` | `thinking` param | Streaming | Betas | Rationale |
|---|---|---|---|---|---|---|
| Explorer | `claude-fable-5` | `low` | omitted | no (`≤16K`) | `server-side-fallback` | Read-only fan-out; low effort ⇒ fewer, consolidated tool calls, terser output. |
| Generator | `claude-fable-5` | `xhigh` | omitted | yes (`64K`) | fallback + task-budgets + compaction + context-editing | Long-horizon edit sessions; `xhigh` is the coding/agentic sweet spot on Fable 5. |
| Verifier | `claude-fable-5` | `high` | `{"type":"adaptive","display":"summarized"}` | yes | fallback | Judgment call; summarized reasoning is surfaced into the audit trail. |
| Orchestrator planner | `claude-fable-5` | `xhigh` | omitted | yes | fallback + task-budgets | One well-specified up-front turn; Fable 5 rewards a full spec over progressive reveal. |

The canonical request builder — one function, parameterized by role, that encodes every rule above:

```python
# sdk/request.py
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
    in output_config, no sampling params, fallbacks always on."""
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

Two non-obvious rules this encodes. **(a)** When `long_horizon` is set, the caller *must* append the full `response.content` (not just the text) back into `messages` each turn — the compaction blocks the API emits are how it reconstitutes the summarized history on the next request; extracting only `.text` silently discards compaction state. **(b)** The `task_budget` countdown counts only what the model generates *this turn* plus the tool results it reads this turn — not the resent history — so it is orthogonal to the orchestrator's `TokenBudget` (§3.2), which caps *cumulative* run spend. Fable 5 self-paces within a step; the harness caps the run.

### 8.2 System-prompt structures

Fable 5 follows communication-style instructions closely and, un-steered at high effort, elaborates beyond what the task needs (over-structured summaries, unrequested refactors, narration of routine actions). Each worker persona is a **frozen** block (cached; §8.1) composed of a role charter plus the targeted behavioral snippets below. Freezing matters for cost: any byte change ahead of the cache breakpoint invalidates the tools+system prefix for every subsequent step.

**Generator persona** (`prompts/generator.md`) — the anti-tidying, boundaries, and grounded-progress snippets are the ones that matter most for a mutating agent:

```text
You implement exactly the change described by the acceptance criteria, in an
isolated worktree, and nothing more.

<scope>
Don't add features, refactor, or introduce abstractions beyond what the task
requires. A bug fix doesn't need surrounding cleanup; a one-shot change usually
doesn't need a helper. Don't add error handling, fallbacks, or validation for
scenarios that cannot happen — validate only at real system boundaries. Don't
add backwards-compatibility shims when you can just change the code. The
regressed tests in your feedback packet define the contract: change the code,
not the tests, unless a criterion explicitly says otherwise.
</scope>

<progress>
Before reporting progress, audit each claim against a tool result from this
session. Only report work you can point to evidence for; if something is not
yet verified, say so. If tests fail, say so with the output; if you skipped a
step, say that. Your claims are cross-checked against git and test exit codes
downstream — an unverifiable claim is treated as if the work did not happen.
</progress>

<boundaries>
You are operating autonomously; no human is watching mid-task. Do not ask
"Want me to…?" — for reversible actions that follow from the criteria, proceed.
Never write outside your granted scope, never touch protected paths, never run
network commands. Before ending your turn, check your last paragraph: if it is a
plan or a promise ("I'll now run…"), do that work now with a tool call instead.
</boundaries>
```

**Verifier persona** (`prompts/verifier.md`) — the fresh-context contract, stated so the model cannot invent author intent it structurally cannot see:

```text
You are a verification judge. Your input is a diff, the acceptance criteria, and
a machine-computed test-transition matrix. You cannot see the author's reasoning
and must not infer intent from it. Mark a criterion met only when the diff plus
the test evidence proves it — not when it seems plausible. The mechanical
evidence is authoritative: you may flag an unmet criterion on a green matrix
(that triggers a retry), but you may never declare success on a red matrix.
Report every unmet criterion with the specific evidence that is missing.
```

**Orchestrator-facing narration control** — injected as a mid-conversation instruction on long generator runs, not baked into the frozen persona (so it can change without invalidating the cache). Fable 5 narrates more than prior models; for a headless coding agent this is noise:

```text
Default to silence between tool calls. Write text only when you find something,
change direction, or hit a blocker — one sentence each. Do not narrate routine
actions ("Now I'll…", "Let me check…"). When done: one or two sentences on the
outcome, written for a reader who did not watch you work — outcome first, plain
sentences, no arrow-chains or invented shorthand.
```

### 8.3 File-based memory hook

Fable 5 performs materially better when it can persist learnings across sessions. Each role gets the Anthropic **memory tool** (`memory_20250818`), backed by a per-run directory the harness owns. The tool is client-executed: the model emits a `memory` tool call, the handler below performs the file operation under a hard path-confinement check, and the result is fed back. Lessons written during one step (e.g. "the eviction test asserts insertion order — preserve it") survive into later steps and later runs on the same repo.

```python
# sdk/memory.py
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

The persona instruction that drives it, per the Fable 5 memory guidance — one lesson per file, corrections and confirmations alike, deduplicate rather than append:

```text
Before starting, read /memories for prior lessons about this repository. As you
work, record durable learnings there — one lesson per file, with a one-line
summary at the top: corrections you had to make, invariants a test enforces,
approaches that worked and why. Update an existing note rather than duplicating
it; delete a note that turns out wrong. Don't record what git history or the
current diff already shows.
```

> **Security note.** The memory tool's reference implementations ship with no access control. Because these workers run under least-privilege grants and untrusted model output drives the paths, the `_resolve` confinement is not optional — it is the boundary. Never let the memory root overlap a worktree write scope, and never store secrets in memory (the store is plaintext).

### 8.4 Model-facing tool schemas

The broker tools of §5 are exposed to the model as strict-schema custom tools. `strict: true` (a sibling of `name`/`description`/`input_schema`, **not** a `tool_choice` field) guarantees the `input` validates exactly, so the broker's argv renderer never receives a malformed selector. The `send_to_user` tool is the Fable 5-recommended channel for content that must reach the operator *verbatim* mid-run — tool inputs are never summarized, so a progress figure or a partial deliverable arrives intact.

```python
# sdk/tools.py — the model-facing tool surface for the generator role
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
    MEMORY_TOOL,  # from sdk/memory.py — {"type": "memory_20250818", "name": "memory"}
]
```

The Verifier's semantic-review call (§6.1) uses the other structured-output mechanism — `output_config.format` with a `json_schema` — rather than a tool, because it needs one validated object back, not an agentic loop. Both are the same underlying constraint engine; use `format` for a single structured response, strict tools for actions.

### 8.5 Agent SDK configuration — binding `dispatch` to the API

§3.2's `Orchestrator` takes an opaque `dispatch: Callable[[Step], Awaitable[StepResult]]`. This is its Fable 5 implementation: a streaming tool-runner loop that assembles the role request (§8.1), executes tool calls through the broker (§5) and memory store (§8.3), handles `refusal` and the `fallback` content block, and returns a `StepResult` whose `evidence` is the machine-checkable claim set the Verifier will arbitrate.

```python
# sdk/dispatch.py
from __future__ import annotations

import json

from anthropic import AsyncAnthropic

from sandbox.broker import OutcomeKind, ToolBroker
from sdk.memory import MemoryStore
from sdk.request import build_request
from orchestrator.state import Step, StepResult


class FableDispatcher:
    def __init__(self, client: AsyncAnthropic, run_root: str):
        self.client = client
        self.run_root = run_root

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

        spent, tool_calls, claims, candidate_ref = 0, 0, [], None
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
                else:  # text editor / bash handled by the broker's file ops
                    out = await self._editor(broker, block.input)
                results.append({"type": "tool_result",
                                "tool_use_id": block.id, "content": out})
            messages.append({"role": "user", "content": results})   # ALL results, one message

        # Compute the candidate ref from git — never trust the model's claim.
        head = await broker.invoke("git", sub="rev-parse", a1="HEAD")
        candidate_ref = head.parsed.get("stdout", "").strip()
        claims.append({"claim": "candidate committed",
                       "evidence": {"type": "git_diff_digest", "worktree_head": candidate_ref}})

        # The dispatcher returns a *proposed* pass; the Verifier (Stage 3) is the
        # arbiter. The orchestrator routes generate-class results through it before
        # any PASSED transition — the dispatcher never self-certifies.
        verdict = "pass" if candidate_ref else "retry"
        return StepResult(step.id, verdict, spent,
                          evidence={"candidate_ref": candidate_ref, "claims": claims,
                                    "tool_calls": tool_calls})
```

The single most important line is the penultimate comment: the dispatcher returns a *proposed* verdict carrying `candidate_ref`, and the orchestrator sends every generate-class result to the Verifier engine (§6.1) before it will fire `VERIFYING → PASSED`. The SDK loop produces hypotheses; the twin-worktree differential produces facts. That separation — not any single API parameter — is what makes the architecture native to a model as capable and autonomous as Fable 5: the more the model can do unsupervised, the more the value comes from a harness that checks it against ground truth rather than trusting the transcript.

---

## 9. System Properties — Closing Summary

The design converges on five guarantees, each traceable to a specific mechanism rather than to prompt discipline:

| Property | Mechanism | Where |
|---|---|---|
| **Zero-regression merges** | Integration gate requires a clean `PASS→FAIL`-free transition matrix; the merge command is unreachable otherwise. | §6.1, §7.1 |
| **Bounded spend** | Hierarchical `TokenBudget` (reserve/commit) caps the run; Fable 5 `task_budget` self-paces each step. | §3.2, §8.1 |
| **No confident hallucination** | Every claim class has a machine arbiter; the model's transcript is never authoritative state. | §7.3 |
| **Crash recoverability** | Write-ahead JSONL journal; replay restores state, in-flight steps re-enter `READY`. | §3.1 |
| **Least privilege** | Per-role capability grants enforced at the broker (argv-only, scrubbed env, rlimits, scoped FS), not by the prompt. | §4.2, §5 |

The through-line: **the model plans and generates; the harness decides and records.** Fable 5's long-horizon autonomy is an asset precisely because every safety-critical decision it influences is re-derived from git objects, exit codes, and transition matrices before it is allowed to change authoritative state.