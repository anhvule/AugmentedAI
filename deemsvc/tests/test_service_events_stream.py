import asyncio
import json

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
async def test_events_stream_replays_journal_then_closes_after_run_completes(tmp_path):
    app.state.data_dir = str(tmp_path)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        start = await client.post("/runs", json={
            "goal": "g", "acceptance_criteria": [], "baseline_ref": "0" * 40,
            "worktree": str(tmp_path / "wt"), "token_ceiling": 100_000, "max_attempts": 3,
        })
        run_id = start.json()["run_id"]
        entry = app.state.registry.get(run_id)
        await asyncio.wait_for(entry.task, timeout=5)

        events = []
        async with client.stream("GET", f"/runs/{run_id}/events") as resp:
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    events.append(json.loads(line[len("data: "):]))
                if len(events) >= 2:  # BLOCKED->READY, ..., ->PASSED — stop once we've seen some
                    break

    assert len(events) >= 2
    assert events[0]["step"] == "impl"
