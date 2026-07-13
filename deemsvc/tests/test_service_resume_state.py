import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from deemsvc.orchestrator.stub_dispatch import ScriptedDispatcher
from deemsvc.service.app import app


@pytest.fixture(autouse=True)
def stub_dispatcher_factory():
    # Always escalates on the first attempt so /resume has something to act on.
    original = app.state.dispatcher_factory
    app.state.dispatcher_factory = lambda intent, budget, agent_name: ScriptedDispatcher(
        script={"impl": ["escalate"]})
    yield
    app.state.dispatcher_factory = original


@pytest.mark.asyncio
async def test_state_reflects_escalation_and_resume_reruns_to_completion(tmp_path):
    app.state.data_dir = str(tmp_path)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        start = await client.post("/runs", json={
            "goal": "g", "acceptance_criteria": [], "baseline_ref": "0" * 40,
            "worktree": str(tmp_path / "wt"), "token_ceiling": 100_000, "max_attempts": 1,
        })
        run_id = start.json()["run_id"]
        entry = app.state.registry.get(run_id)
        await asyncio.wait_for(entry.task, timeout=5)

        state = (await client.get(f"/runs/{run_id}/state")).json()
        assert state["steps"]["impl"]["status"] == "escalated"

        # Swap the script so the next dispatch passes, then resume.
        entry.graph["impl"].payload = entry.graph["impl"].payload  # no-op, for clarity
        app.state.dispatcher_factory = lambda intent, budget, agent_name: ScriptedDispatcher()
        resume = await client.post(f"/runs/{run_id}/resume", json={"step_id": "impl"})
        assert resume.status_code == 200
        # /resume kicks off a new background orchestrator.run() task (same
        # fire-and-forget pattern as POST /runs); give it a chance to finish
        # before asserting on state, exactly like every other test in this
        # suite that waits on entry.task after triggering a run. Without this,
        # the ASGITransport round trip for GET /state does not reliably give
        # the newly created task any event-loop turns (confirmed empirically:
        # the assertion below flakes to "ready"/attempts 0 otherwise).
        await asyncio.wait_for(entry.task, timeout=5)

        final_state = (await client.get(f"/runs/{run_id}/state")).json()
    assert final_state["steps"]["impl"]["status"] == "passed"
    assert final_state["done"] is True
