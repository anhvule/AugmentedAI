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
