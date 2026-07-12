import pytest

from deemsvc.orchestrator.state import Step, StepStatus
from deemsvc.orchestrator.stub_dispatch import ScriptedDispatcher


@pytest.mark.asyncio
async def test_dispatcher_returns_scripted_verdict_by_attempt():
    dispatcher = ScriptedDispatcher(script={"impl": ["retry", "pass"]})
    step = Step(id="impl", step_class="generate", payload={}, deps=frozenset(),
                status=StepStatus.EXECUTING, attempts=1)
    first = await dispatcher(step)
    assert first.verdict == "retry"
    assert first.feedback is not None

    step.attempts = 2
    second = await dispatcher(step)
    assert second.verdict == "pass"


@pytest.mark.asyncio
async def test_dispatcher_defaults_to_pass_for_unscripted_steps():
    dispatcher = ScriptedDispatcher(script={})
    step = Step(id="explore", step_class="explore", payload={}, deps=frozenset(),
                status=StepStatus.EXECUTING, attempts=1)
    result = await dispatcher(step)
    assert result.verdict == "pass"


@pytest.mark.asyncio
async def test_dispatcher_records_calls_in_order():
    dispatcher = ScriptedDispatcher(script={})
    step = Step(id="s1", step_class="generate", payload={}, deps=frozenset(),
                status=StepStatus.EXECUTING, attempts=1)
    await dispatcher(step)
    await dispatcher(step)
    assert dispatcher.calls == ["s1", "s1"]
