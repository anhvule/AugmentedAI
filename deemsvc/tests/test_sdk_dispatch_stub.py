import subprocess
from types import SimpleNamespace

import pytest

from deemsvc.orchestrator.state import Step
from deemsvc.sdk.adapter import AgentAdapter
from deemsvc.sdk.dispatch import FableDispatcher


def _text_block(text):
    return SimpleNamespace(type="text", text=text)


def _tool_use_block(id_, name, input_):
    return SimpleNamespace(type="tool_use", id=id_, name=name, input=input_)


class _FakeStreamCtx:
    def __init__(self, message):
        self._message = message

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get_final_message(self):
        return self._message


def _message(content, stop_reason, usage_in=100, usage_out=50, stop_details=None):
    return SimpleNamespace(
        content=content, stop_reason=stop_reason, stop_details=stop_details,
        usage=SimpleNamespace(input_tokens=usage_in, output_tokens=usage_out),
    )


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
        payload={
            "system_blocks": [{"type": "text", "text": "persona"}],
            "tools": [],
            "objective": "do the thing",
            "capability_grant": {"worktree": worktree_path},
        },
    )


def test_fable_dispatcher_satisfies_the_agent_adapter_protocol():
    assert isinstance(FableDispatcher(client=None, run_root="."), AgentAdapter)


@pytest.mark.asyncio
async def test_dispatcher_returns_pass_with_real_head_sha_after_tool_use_then_end_turn(worktree):
    # Turn 1: model uses send_to_user, and (simulating the server-executed
    # text-editor tool committing a real change out-of-band) a new commit
    # lands on the worktree. Turn 2: model ends its turn. candidate_ref must
    # reflect that *moved* HEAD, not merely any pre-existing HEAD.
    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=None)))
    calls = [
        _FakeStreamCtx(_message(
            [_tool_use_block("t1", "send_to_user", {"message": "progress"})], "tool_use")),
        _FakeStreamCtx(_message([_text_block("done")], "end_turn")),
    ]

    def _stream(**kwargs):
        if len(calls) == 2:  # first turn: simulate a real out-of-band commit
            (worktree / "change.txt").write_text("edit\n")
            subprocess.run(["git", "add", "-A"], cwd=worktree, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "candidate"], cwd=worktree, check=True)
        return calls.pop(0)

    client.beta.messages.stream = _stream

    dispatcher = FableDispatcher(client, str(worktree))
    step = _step(str(worktree))
    result = await dispatcher(step)

    assert result.verdict == "pass"
    assert result.evidence["candidate_ref"]
    assert len(result.evidence["candidate_ref"]) == 40  # a real git SHA
    assert result.tokens_spent == (100 + 50) * 2  # two turns


@pytest.mark.asyncio
async def test_dispatcher_retries_when_the_model_ends_its_turn_without_committing(worktree):
    # The model ends its turn immediately — no tool_use, no commit. The
    # worktree already has a prior commit (see the `worktree` fixture), so a
    # bare post-run `git rev-parse HEAD` would still resolve to a real SHA.
    # The dispatcher must recognize HEAD never moved and report "retry" with
    # an empty candidate_ref, not misreport the stale HEAD as a pass.
    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=None)))
    client.beta.messages.stream = lambda **kwargs: _FakeStreamCtx(
        _message([_text_block("nothing to do")], "end_turn"))

    dispatcher = FableDispatcher(client, str(worktree))
    step = _step(str(worktree))
    result = await dispatcher(step)

    assert result.verdict == "retry"
    assert result.evidence["candidate_ref"] == ""


@pytest.mark.asyncio
async def test_dispatcher_escalates_on_final_refusal(worktree):
    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=None)))
    refusal = _message([], "refusal", stop_details=SimpleNamespace(category="policy"))
    client.beta.messages.stream = lambda **kwargs: _FakeStreamCtx(refusal)

    dispatcher = FableDispatcher(client, str(worktree))
    step = _step(str(worktree))
    result = await dispatcher(step)

    assert result.verdict == "escalate"
    assert result.evidence["refusal"] == "policy"


@pytest.mark.asyncio
async def test_dispatcher_routes_memory_tool_calls_through_the_memory_store(worktree):
    calls = [
        _FakeStreamCtx(_message(
            [_tool_use_block("t1", "memory", {"command": "create", "path": "/memories/note.md",
                                              "file_text": "lesson learned"})], "tool_use")),
        _FakeStreamCtx(_message([_text_block("done")], "end_turn")),
    ]
    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(
        stream=lambda **kwargs: calls.pop(0))))

    dispatcher = FableDispatcher(client, str(worktree))
    step = _step(str(worktree))
    await dispatcher(step)

    note = (worktree / "memories" / "note.md")
    assert note.exists()
    assert "lesson learned" in note.read_text()
