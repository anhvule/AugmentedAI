from deemsvc.verifier.engine import Transition, TestDelta, VerificationTask, VerifierEngine


def _task(**overrides) -> VerificationTask:
    defaults = dict(step_id="impl", repo_root="/repo", baseline_ref="base",
                    candidate_ref="cand", acceptance_criteria=("AC-1",),
                    attempt=1, max_attempts=3, prior_signatures=frozenset(),
                    changed_paths=("server/cache.py",))
    defaults.update(overrides)
    return VerificationTask(**defaults)


def test_zero_regressions_and_all_criteria_met_passes():
    engine = VerifierEngine("/repo")
    semantic = {"criteria": [{"id": "AC-1", "met": True, "evidence": "diff shows it"}]}
    verdict = engine._adjudicate(_task(), budget_headroom=100_000,
                                 regressions=[], new_failing=[], flaky=[], lint=[],
                                 semantic=semantic)
    assert verdict.decision == "pass"


def test_a_confirmed_regression_never_passes_regardless_of_semantic_judgment():
    engine = VerifierEngine("/repo")
    semantic = {"criteria": [{"id": "AC-1", "met": True, "evidence": "looks right"}]}
    regression = [TestDelta("t1", Transition.REGRESSION, "boom")]
    verdict = engine._adjudicate(_task(), budget_headroom=100_000,
                                 regressions=regression, new_failing=[], flaky=[], lint=[],
                                 semantic=semantic)
    assert verdict.decision != "pass"


def test_unmet_criterion_on_a_green_matrix_blocks_pass():
    engine = VerifierEngine("/repo")
    semantic = {"criteria": [{"id": "AC-1", "met": False, "evidence": "not found in diff"}]}
    verdict = engine._adjudicate(_task(), budget_headroom=100_000,
                                 regressions=[], new_failing=[], flaky=[], lint=[],
                                 semantic=semantic)
    assert verdict.decision != "pass"


def test_novel_signature_with_budget_and_attempts_retries_with_feedback():
    engine = VerifierEngine("/repo")
    semantic = {"criteria": []}
    regression = [TestDelta("t1", Transition.REGRESSION, "boom")]
    verdict = engine._adjudicate(_task(attempt=1, max_attempts=3), budget_headroom=100_000,
                                 regressions=regression, new_failing=[], flaky=[], lint=[],
                                 semantic=semantic)
    assert verdict.decision == "retry"
    assert verdict.feedback is not None
    assert verdict.feedback["regressions"][0]["test_id"] == "t1"


def test_attempt_ceiling_escalates_even_with_budget_headroom():
    engine = VerifierEngine("/repo")
    regression = [TestDelta("t1", Transition.REGRESSION, "boom")]
    verdict = engine._adjudicate(_task(attempt=3, max_attempts=3), budget_headroom=100_000,
                                 regressions=regression, new_failing=[], flaky=[], lint=[],
                                 semantic={"criteria": []})
    assert verdict.decision == "escalate"
    assert "attempt ceiling" in verdict.reason


def test_budget_below_floor_escalates_even_on_first_attempt():
    engine = VerifierEngine("/repo")
    regression = [TestDelta("t1", Transition.REGRESSION, "boom")]
    verdict = engine._adjudicate(_task(attempt=1, max_attempts=3),
                                 budget_headroom=engine.TOKEN_FLOOR - 1,
                                 regressions=regression, new_failing=[], flaky=[], lint=[],
                                 semantic={"criteria": []})
    assert verdict.decision == "escalate"
    assert "budget headroom" in verdict.reason


def test_repeated_signature_escalates_instead_of_retrying_again():
    engine = VerifierEngine("/repo")
    regression = [TestDelta("t1", Transition.REGRESSION, "boom")]
    sig = engine._failure_signature(regression, [], [])
    verdict = engine._adjudicate(_task(attempt=2, max_attempts=5, prior_signatures=frozenset({sig})),
                                 budget_headroom=100_000,
                                 regressions=regression, new_failing=[], flaky=[], lint=[],
                                 semantic={"criteria": []})
    assert verdict.decision == "escalate"
    assert "repeated failure signature" in verdict.reason


def test_flaky_quarantine_and_lint_findings_are_carried_through_the_verdict():
    engine = VerifierEngine("/repo")
    verdict = engine._adjudicate(_task(), budget_headroom=100_000,
                                 regressions=[], new_failing=[], flaky=["t_flaky"],
                                 lint=[{"path": "a.py", "line": 1, "code": "F401", "msg": "unused"}],
                                 semantic={"criteria": []})
    assert verdict.decision != "pass"  # lint finding present -> not clean
    assert verdict.flaky_quarantined == ["t_flaky"]
    assert verdict.lint[0]["code"] == "F401"
