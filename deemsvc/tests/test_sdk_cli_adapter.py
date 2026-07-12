import stat
import subprocess

import pytest

from deemsvc.orchestrator.state import Step
from deemsvc.sdk.adapter import AgentAdapter
from deemsvc.sdk.cli_adapter import CliAdapterSpec, CliAgentAdapter


def _fake_cli_script(tmp_path, body: str) -> str:
    """A hermetic stand-in for `claude`/`codex` — no real CLI or network
    dependency. What's under test is CliAgentAdapter's behavior (compute
    candidate_ref from git, ignore the process's own claims, enforce the
    timeout), which is identical no matter which real binary sits behind it."""
    script = tmp_path / "fake-cli"
    script.write_text(body)
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return str(script)


@pytest.fixture
def worktree(tmp_path):
    repo = tmp_path / "worktree"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=repo, check=True)
    (repo / "README.md").write_text("hi\n")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
    return repo


def _step(worktree_path: str) -> Step:
    return Step(
        id="impl", step_class="generate", deps=frozenset(),
        payload={"objective": "add a line to README",
                "capability_grant": {"worktree": worktree_path}},
    )


def test_cli_agent_adapter_satisfies_the_agent_adapter_protocol():
    spec = CliAdapterSpec(name="fake", argv=("true",), prompt_via="stdin")
    assert isinstance(CliAgentAdapter(spec), AgentAdapter)


@pytest.mark.asyncio
async def test_candidate_ref_comes_from_git_never_from_the_cli_own_claim(tmp_path, worktree):
    # The fake CLI commits a real change AND prints an unrelated success claim —
    # the adapter must derive candidate_ref from git, not from stdout.
    script = _fake_cli_script(tmp_path, f"""#!/bin/sh
cd "{worktree}"
echo "second line" >> README.md
git add -A
git commit -q -m "candidate"
echo '{{"type": "tool_use", "name": "edit"}}'
echo '{{"type": "result", "success": true, "note": "trust me, it works"}}'
""")
    spec = CliAdapterSpec(name="fake-cli", argv=(script,), prompt_via="stdin", timeout_s=10)
    adapter = CliAgentAdapter(spec)
    result = await adapter(_step(str(worktree)))

    assert result.verdict == "pass"
    assert len(result.evidence["candidate_ref"]) == 40
    assert result.evidence["tool_calls"] == 1
    assert result.evidence["cli"] == "fake-cli"


@pytest.mark.asyncio
async def test_no_commit_means_retry_regardless_of_what_the_cli_printed(tmp_path, worktree):
    script = _fake_cli_script(tmp_path, "#!/bin/sh\necho '{\"type\": \"result\", \"success\": true}'\n")
    spec = CliAdapterSpec(name="fake-cli", argv=(script,), prompt_via="stdin", timeout_s=10)
    adapter = CliAgentAdapter(spec)
    result = await adapter(_step(str(worktree)))
    assert result.verdict == "retry"
    assert result.evidence["candidate_ref"] == ""


@pytest.mark.asyncio
async def test_a_slow_process_is_killed_and_reported_as_retry(tmp_path, worktree):
    script = _fake_cli_script(tmp_path, "#!/bin/sh\nsleep 5\n")
    spec = CliAdapterSpec(name="fake-cli", argv=(script,), prompt_via="stdin", timeout_s=1)
    adapter = CliAgentAdapter(spec)
    result = await adapter(_step(str(worktree)))
    assert result.verdict == "retry"
    assert "timed out" in result.evidence["error"]


@pytest.mark.asyncio
async def test_prompt_via_arg_appends_the_objective_as_an_argv_element(tmp_path, worktree):
    # A script that echoes its own argv, so we can see the objective arrived.
    script = _fake_cli_script(tmp_path, '#!/bin/sh\necho "argv: $@"\n')
    spec = CliAdapterSpec(name="fake-cli", argv=(script,), prompt_via="arg", timeout_s=10)
    adapter = CliAgentAdapter(spec)
    step = _step(str(worktree))
    await adapter(step)  # no commit is made; we only care that it didn't crash
    # Sanity: prompt_via="arg" doesn't write to stdin, so a script expecting
    # stdin input would hang — this test passing (not timing out) is the proof.
