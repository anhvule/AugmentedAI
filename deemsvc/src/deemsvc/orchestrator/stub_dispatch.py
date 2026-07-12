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
