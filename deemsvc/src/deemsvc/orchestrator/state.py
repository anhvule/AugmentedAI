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
    StepStatus.BLOCKED:    frozenset({StepStatus.READY, StepStatus.ESCALATED, StepStatus.ABANDONED}),
    # NOTE: ESCALATED was added here during Task 5. The orchestrator's frontier
    # scanner promotes BLOCKED -> READY before checking budget (READY means
    # "awaiting budget + slot", per the enum docstring); when the subsequent
    # TokenBudget.reserve() call raises BudgetExhausted, the step must be able
    # to move directly from READY to ESCALATED. Without this entry that path
    # raises IllegalTransition on every budget-starved dispatch attempt. See
    # task-5-report.md "Deviations from brief" for the full trace.
    StepStatus.READY:      frozenset({StepStatus.DISPATCHED, StepStatus.ESCALATED,
                                      StepStatus.ABANDONED}),
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
