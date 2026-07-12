from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
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
