import subprocess
from unittest.mock import AsyncMock

import pytest

from deemsvc.verifier.engine import VerificationTask, VerifierEngine

FIXTURE = "tests/fixtures/verifier_repo/build.sh"


@pytest.fixture
def repo_with_refs(tmp_path):
    dest = tmp_path / "verifier_repo"
    out = subprocess.run(["bash", FIXTURE, str(dest)], check=True,
                         capture_output=True, text=True)
    baseline, candidate = out.stdout.strip().split()
    return str(dest), baseline, candidate


@pytest.mark.asyncio
async def test_verify_end_to_end_retries_on_a_confirmed_regression(repo_with_refs, monkeypatch):
    repo_root, baseline, candidate = repo_with_refs
    engine = VerifierEngine(repo_root)
    monkeypatch.setattr(
        engine, "_semantic_review",
        AsyncMock(return_value={"criteria": [], "scope_creep": False, "notes": "stubbed"}),
    )
    task = VerificationTask(
        step_id="e2e", repo_root=repo_root, baseline_ref=baseline, candidate_ref=candidate,
        acceptance_criteria=(), attempt=1, max_attempts=3, prior_signatures=frozenset(),
        changed_paths=("tests/test_suite.py",),
    )
    verdict = await engine.verify(task, budget_headroom=100_000)
    assert verdict.decision == "retry"
    # NOTE: classname is "tests.test_suite" (dotted path), not empty — pytest's
    # JUnit XML derives classname from the module's path relative to rootdir for
    # nested test files (see plan3-task-4-report.md's "Deviations from brief" for
    # the same finding, verified empirically there and reconfirmed here). The
    # brief's literal "::test_will_regress" assumes an empty classname.
    assert any(d.test_id == "tests.test_suite::test_will_regress" for d in verdict.regressions)
    assert verdict.feedback is not None


@pytest.mark.asyncio
async def test_verify_passes_when_a_second_engine_sees_no_further_regressions(monkeypatch, tmp_path):
    # A repo where baseline == candidate has zero transitions by construction.
    # NOTE: the test file lives under tests/, not the repo root — `_snapshot`'s
    # default selector is the literal string "tests" (see engine.py, unchanged by
    # this task's brief and already covered by Task 4's own tests), so a
    # top-level test file would make pytest fail with "file or directory not
    # found: tests" before ever reaching the "pass" verdict this test exercises.
    dest = tmp_path / "clean_repo"
    (dest / "tests").mkdir(parents=True)
    (dest / "pytest.ini").write_text("[pytest]\naddopts = -p no:cacheprovider\n")
    (dest / "tests" / "test_clean.py").write_text("def test_ok():\n    assert True\n")
    subprocess.run(["git", "init", "-q"], cwd=dest, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=dest, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=dest, check=True)
    subprocess.run(["git", "add", "-A"], cwd=dest, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "only commit"], cwd=dest, check=True)
    sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=dest,
                         capture_output=True, text=True, check=True).stdout.strip()

    engine = VerifierEngine(str(dest))
    from unittest.mock import AsyncMock
    monkeypatch.setattr(
        engine, "_semantic_review",
        AsyncMock(return_value={"criteria": [], "scope_creep": False, "notes": "stubbed"}),
    )
    task = VerificationTask(step_id="clean", repo_root=str(dest), baseline_ref=sha,
                            candidate_ref=sha, acceptance_criteria=(), attempt=1,
                            max_attempts=3, prior_signatures=frozenset(), changed_paths=())
    verdict = await engine.verify(task, budget_headroom=100_000)
    assert verdict.decision == "pass"
