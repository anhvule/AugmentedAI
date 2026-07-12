import pytest

from deemsvc.orchestrator.state import Step, StepResult
from deemsvc.sdk.adapter import AgentAdapter


class _TrivialAdapter:
    async def __call__(self, step: Step) -> StepResult:
        return StepResult(step.id, "pass", 0, {})


def test_a_correctly_shaped_class_satisfies_the_protocol():
    assert isinstance(_TrivialAdapter(), AgentAdapter)


def test_an_object_missing_call_does_not_satisfy_the_protocol():
    class NotAnAdapter:
        pass
    assert not isinstance(NotAnAdapter(), AgentAdapter)


@pytest.mark.asyncio
async def test_the_trivial_adapter_actually_works_as_a_dispatch_callable():
    step = Step(id="s", step_class="generate", payload={}, deps=frozenset())
    result = await _TrivialAdapter()(step)
    assert result.verdict == "pass"
