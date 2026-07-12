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
