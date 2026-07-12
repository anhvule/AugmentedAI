import os

import pytest

from deemsvc.verifier.engine import Transition, TestDelta, VerificationTask, VerifierEngine

pytestmark = pytest.mark.skipif(
    not os.environ.get("ANTHROPIC_API_KEY"),
    reason="semantic review calls the real Anthropic API",
)


@pytest.fixture
def repo_with_diff(tmp_path):
    import subprocess
    repo = tmp_path / "semantic_repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=repo, check=True)
    (repo / "cache.py").write_text("def get(key):\n    return CACHE.get(key)\n")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "baseline"], cwd=repo, check=True)
    baseline = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                              capture_output=True, text=True, check=True).stdout.strip()
    (repo / "cache.py").write_text(
        "def get(key, schema_version):\n    return CACHE.get((key, schema_version))\n"
    )
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "candidate"], cwd=repo, check=True)
    candidate = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                               capture_output=True, text=True, check=True).stdout.strip()
    return str(repo), baseline, candidate


@pytest.mark.asyncio
async def test_semantic_review_returns_a_schema_shaped_verdict(repo_with_diff):
    from anthropic import AsyncAnthropic

    repo_root, baseline, candidate = repo_with_diff
    engine = VerifierEngine(repo_root, client=AsyncAnthropic())
    task = VerificationTask(
        step_id="s", repo_root=repo_root, baseline_ref=baseline, candidate_ref=candidate,
        acceptance_criteria=("Cache key includes schema_version",), attempt=1,
        max_attempts=3, prior_signatures=frozenset(), changed_paths=("cache.py",),
    )
    result = await engine._semantic_review(task, repo_root, deltas=[])
    assert "criteria" in result
    assert isinstance(result["criteria"], list)
    assert "scope_creep" in result
    assert isinstance(result["scope_creep"], bool)
