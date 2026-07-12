import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from deemsvc.orchestrator.stub_dispatch import ScriptedDispatcher
from deemsvc.service.app import app


@pytest.fixture(autouse=True)
def stub_dispatcher_factory():
    original = app.state.dispatcher_factory
    app.state.dispatcher_factory = lambda intent, budget, agent_name: ScriptedDispatcher()
    yield
    app.state.dispatcher_factory = original


@pytest.mark.asyncio
async def test_post_runs_returns_a_run_id(tmp_path):
    transport = ASGITransport(app=app)
    app.state.data_dir = str(tmp_path)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/runs", json={
            "goal": "add a flag", "acceptance_criteria": ["AC-1"],
            "baseline_ref": "0" * 40, "worktree": str(tmp_path / "wt"),
            "token_ceiling": 100_000, "max_attempts": 3,
        })
    assert resp.status_code == 200
    run_id = resp.json()["run_id"]
    assert run_id

    entry = app.state.registry.get(run_id)
    assert entry is not None
    assert entry.agent == "fable5-native"  # the default when the request omits it
    await asyncio.wait_for(entry.task, timeout=5)
    assert entry.graph["impl"].status.value == "passed"


@pytest.mark.asyncio
async def test_post_runs_honors_an_explicit_agent_choice(tmp_path):
    transport = ASGITransport(app=app)
    app.state.data_dir = str(tmp_path)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/runs", json={
            "goal": "add a flag", "acceptance_criteria": ["AC-1"],
            "baseline_ref": "0" * 40, "worktree": str(tmp_path / "wt"),
            "token_ceiling": 100_000, "max_attempts": 3, "agent": "codex-cli",
        })
    run_id = resp.json()["run_id"]
    assert app.state.registry.get(run_id).agent == "codex-cli"
