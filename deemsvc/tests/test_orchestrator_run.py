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
