from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal


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
