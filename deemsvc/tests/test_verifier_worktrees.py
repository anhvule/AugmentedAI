import subprocess

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


def _task(repo_root, baseline, candidate, **overrides) -> VerificationTask:
    defaults = dict(step_id="impl", repo_root=repo_root, baseline_ref=baseline,
                    candidate_ref=candidate, acceptance_criteria=(), attempt=1,
                    max_attempts=3, prior_signatures=frozenset(), changed_paths=())
    defaults.update(overrides)
    return VerificationTask(**defaults)


@pytest.mark.asyncio
async def test_twin_worktrees_are_created_and_removed(repo_with_refs):
    repo_root, baseline, candidate = repo_with_refs
    engine = VerifierEngine(repo_root)
    task = _task(repo_root, baseline, candidate)
    async with engine._twin_worktrees(task) as (base_dir, cand_dir):
        assert (__import__("pathlib").Path(base_dir) / "tests" / "test_suite.py").exists()
        assert (__import__("pathlib").Path(cand_dir) / "tests" / "test_suite.py").exists()
        base_src = (__import__("pathlib").Path(base_dir) / "tests" / "test_suite.py").read_text()
        cand_src = (__import__("pathlib").Path(cand_dir) / "tests" / "test_suite.py").read_text()
        assert "test_new_and_passing" not in base_src
        assert "test_new_and_passing" in cand_src
    result = subprocess.run(["git", "worktree", "list"], cwd=repo_root,
                            capture_output=True, text=True)
    assert base_dir not in result.stdout
    assert cand_dir not in result.stdout


@pytest.mark.asyncio
async def test_snapshot_returns_the_expected_case_matrix(repo_with_refs):
    repo_root, baseline, candidate = repo_with_refs
    engine = VerifierEngine(repo_root)
    task = _task(repo_root, baseline, candidate)
    async with engine._twin_worktrees(task) as (base_dir, cand_dir):
        before = await engine._snapshot(base_dir)
        after = await engine._snapshot(cand_dir)
    # NOTE: classname is "tests.test_suite" (dotted path), not empty — pytest's
    # JUnit XML derives classname from the module's path relative to rootdir for
    # nested test files. See "Deviations from brief" in the task report.
    assert before["tests.test_suite::test_will_regress"] == "PASS"
    assert after["tests.test_suite::test_will_regress"].startswith("FAIL")
    assert before["tests.test_suite::test_currently_broken"].startswith("FAIL")
    assert after["tests.test_suite::test_currently_broken"] == "PASS"
    assert "tests.test_suite::test_new_and_passing" not in before
    assert after["tests.test_suite::test_new_and_passing"] == "PASS"
