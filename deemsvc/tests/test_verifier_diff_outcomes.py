from deemsvc.verifier.engine import Transition, VerifierEngine


def test_pass_to_fail_is_a_regression():
    before = {"t_a": "PASS"}
    after = {"t_a": "FAIL:AssertionError"}
    deltas = VerifierEngine._diff_outcomes(before, after)
    assert deltas == [__import__("deemsvc.verifier.engine", fromlist=["TestDelta"])
                       .TestDelta("t_a", Transition.REGRESSION, "AssertionError")]


def test_fail_to_fail_is_still_failing_not_a_regression():
    before = {"t_a": "FAIL:old error"}
    after = {"t_a": "FAIL:old error"}
    deltas = VerifierEngine._diff_outcomes(before, after)
    assert deltas[0].kind is Transition.STILL_FAILING


def test_fail_to_pass_is_fixed():
    before = {"t_a": "FAIL:old error"}
    after = {"t_a": "PASS"}
    deltas = VerifierEngine._diff_outcomes(before, after)
    assert deltas[0].kind is Transition.FIXED


def test_new_test_that_fails_is_new_failing():
    deltas = VerifierEngine._diff_outcomes({}, {"t_new": "FAIL:not implemented"})
    assert deltas[0].kind is Transition.NEW_FAILING
    assert deltas[0].trace_head == "not implemented"


def test_new_test_that_passes_is_new_passing():
    deltas = VerifierEngine._diff_outcomes({}, {"t_new": "PASS"})
    assert deltas[0].kind is Transition.NEW_PASSING


def test_test_missing_from_candidate_is_removed():
    deltas = VerifierEngine._diff_outcomes({"t_gone": "PASS"}, {})
    assert deltas[0].kind is Transition.REMOVED


def test_skipped_tests_produce_no_delta_when_unchanged():
    before = {"t_a": "SKIP"}
    after = {"t_a": "SKIP"}
    deltas = VerifierEngine._diff_outcomes(before, after)
    assert deltas == []
