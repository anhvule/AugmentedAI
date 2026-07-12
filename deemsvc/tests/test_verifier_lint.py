import subprocess

import pytest

from deemsvc.verifier.engine import VerificationTask, VerifierEngine


@pytest.fixture
def lint_repo(tmp_path):
    repo = tmp_path / "lint_repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=repo, check=True)
    (repo / "a.py").write_text("import os\n\n\ndef f():\n    return 1\n")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "baseline"], cwd=repo, check=True)
    baseline = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                              capture_output=True, text=True, check=True).stdout.strip()

    # Candidate touches line 5 (adds an unused import there) and leaves the
    # pre-existing unused `os` import on line 1 untouched — that pre-existing
    # finding must NOT appear in diff-scoped results.
    (repo / "a.py").write_text("import os\n\n\ndef f():\n    import sys\n    return 1\n")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "candidate"], cwd=repo, check=True)
    candidate = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                               capture_output=True, text=True, check=True).stdout.strip()
    return str(repo), baseline, candidate


@pytest.mark.asyncio
async def test_lint_findings_are_scoped_to_changed_lines_only(lint_repo):
    repo_root, baseline, candidate = lint_repo
    engine = VerifierEngine(repo_root)
    task = VerificationTask(step_id="s", repo_root=repo_root, baseline_ref=baseline,
                            candidate_ref=candidate, acceptance_criteria=(), attempt=1,
                            max_attempts=3, prior_signatures=frozenset(),
                            changed_paths=("a.py",))
    findings = await engine._diff_scoped_lint(repo_root, task)
    lines = [f["line"] for f in findings]
    assert 5 in lines            # the newly-added unused `import sys`
    assert 1 not in lines        # pre-existing unused `import os` is legacy debt, excluded
