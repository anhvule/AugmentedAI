import pytest

from deemsvc.orchestrator.journal import JsonlJournal, resume_graph
from deemsvc.orchestrator.state import Orchestrator, Step, StepStatus, TokenBudget
from deemsvc.orchestrator.stub_dispatch import ScriptedDispatcher


def test_resume_graph_restores_terminal_statuses(tmp_path):
    path = str(tmp_path / "run.jsonl")
    journal = JsonlJournal(path)
    journal.append({"step": "a", "from": "verifying", "to": "passed"})
    journal.close()

    graph = {"a": Step(id="a", step_class="generate", payload={}, deps=frozenset())}
    resume_graph(graph, path)
    assert graph["a"].status is StepStatus.PASSED


def test_resume_graph_resets_inflight_status_to_blocked(tmp_path):
    path = str(tmp_path / "run.jsonl")
    journal = JsonlJournal(path)
    journal.append({"step": "a", "from": "dispatched", "to": "executing"})  # crash here
    journal.close()

    graph = {"a": Step(id="a", step_class="generate", payload={}, deps=frozenset())}
    resume_graph(graph, path)
    assert graph["a"].status is StepStatus.BLOCKED


def test_resume_graph_ignores_steps_not_in_current_graph(tmp_path):
    path = str(tmp_path / "run.jsonl")
    journal = JsonlJournal(path)
    journal.append({"step": "stale-step", "from": "blocked", "to": "ready"})
    journal.close()

    graph = {"a": Step(id="a", step_class="generate", payload={}, deps=frozenset())}
    resume_graph(graph, path)  # must not raise KeyError
    assert graph["a"].status is StepStatus.BLOCKED


@pytest.mark.asyncio
async def test_resumed_run_reaches_passed_after_simulated_crash(tmp_path):
    path = str(tmp_path / "run.jsonl")
    intent_journal = JsonlJournal(path)
    # Simulate a crash after "a" passed but before "b" (which depends on "a") finished.
    intent_journal.append({"step": "a", "from": "verifying", "to": "passed"})
    intent_journal.append({"step": "b", "from": "dispatched", "to": "executing"})
    intent_journal.close()

    graph = {
        "a": Step(id="a", step_class="explore", payload={}, deps=frozenset()),
        "b": Step(id="b", step_class="generate", payload={}, deps=frozenset({"a"})),
    }
    resume_graph(graph, path)
    assert graph["a"].status is StepStatus.PASSED
    assert graph["b"].status is StepStatus.BLOCKED  # will re-enter READY via _frontier

    from deemsvc.orchestrator.state import Intent
    resumed_intent = Intent(goal="g", acceptance_criteria=(), protected_paths=(),
                            forbidden_actions=(), baseline_ref="0" * 40)
    resume_journal = JsonlJournal(path)
    dispatcher = ScriptedDispatcher()
    orch = Orchestrator(resumed_intent, TokenBudget(ceiling=100_000), dispatcher,
                        resume_journal.append)
    result = await orch.run(graph)
    resume_journal.close()

    assert result["b"].status is StepStatus.PASSED
    # "a" was never re-dispatched — it was already terminal.
    assert "a" not in dispatcher.calls
