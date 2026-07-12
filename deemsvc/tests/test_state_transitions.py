from deemsvc.orchestrator.state import StepStatus, _LEGAL


def test_every_status_has_a_table_entry():
    assert set(_LEGAL.keys()) == set(StepStatus)


def test_blocked_can_go_ready_or_abandoned_only():
    assert _LEGAL[StepStatus.BLOCKED] == frozenset({StepStatus.READY, StepStatus.ABANDONED})


def test_terminal_states_have_no_outbound_edges():
    assert _LEGAL[StepStatus.PASSED] == frozenset()
    assert _LEGAL[StepStatus.ABANDONED] == frozenset()


def test_retrying_is_reachable_only_from_executing_or_verifying():
    # RETRYING is reached either directly from EXECUTING (a dispatch result
    # says "retry") or from VERIFYING (a verifier adjudication says "retry")
    # — never injected from any other state.
    sources_of_retrying = [s for s, targets in _LEGAL.items() if StepStatus.RETRYING in targets]
    assert set(sources_of_retrying) == {StepStatus.EXECUTING, StepStatus.VERIFYING}


def test_escalated_to_ready_is_the_only_reentry_point():
    sources_of_ready = [s for s, targets in _LEGAL.items() if StepStatus.READY in targets]
    assert set(sources_of_ready) == {StepStatus.BLOCKED, StepStatus.ESCALATED}
