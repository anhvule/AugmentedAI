import subprocess

import pytest

from deemsvc.sandbox.broker import OutcomeKind, ToolBroker


@pytest.fixture
def git_repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    (repo / "README.md").write_text("hello\n")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=repo, check=True)
    return repo


@pytest.mark.asyncio
async def test_invoke_git_rev_parse_returns_tool_ok(git_repo):
    broker = ToolBroker(str(git_repo))
    outcome = await broker.invoke("git", sub="rev-parse", a1="HEAD")
    assert outcome.kind is OutcomeKind.TOOL_OK
    assert outcome.exit_code == 0
    assert len(outcome.parsed["stdout"].strip()) == 40  # a full SHA


@pytest.mark.asyncio
async def test_invoke_unknown_git_subcommand_is_tool_misuse(git_repo):
    broker = ToolBroker(str(git_repo))
    outcome = await broker.invoke("git", sub="not-a-real-subcommand")
    assert outcome.kind is OutcomeKind.TOOL_MISUSE


@pytest.mark.asyncio
async def test_invoke_populates_wall_ms(git_repo):
    broker = ToolBroker(str(git_repo))
    outcome = await broker.invoke("git", sub="rev-parse", a1="HEAD")
    assert outcome.wall_ms >= 0


@pytest.mark.asyncio
async def test_drain_flags_truncation_without_blocking(git_repo):
    broker = ToolBroker(str(git_repo))
    proc = await __import__("asyncio").create_subprocess_exec(
        "python3", "-c", "print('x' * 200)",
        stdout=__import__("asyncio").subprocess.PIPE,
        stderr=__import__("asyncio").subprocess.DEVNULL,
    )
    data, truncated = await broker._drain(proc.stdout, cap=10)
    await proc.wait()
    assert len(data) == 10
    assert truncated is True
