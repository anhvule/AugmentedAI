import pytest

from deemsvc.orchestrator.state import Intent


@pytest.fixture
def intent() -> Intent:
    return Intent(
        goal="test goal",
        acceptance_criteria=("AC-1",),
        protected_paths=(),
        forbidden_actions=(),
        baseline_ref="0" * 40,
    )
