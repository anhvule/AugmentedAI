import asyncio
import builtins
import json

import pytest
from httpx import ASGITransport, AsyncClient

from deemsvc.orchestrator.state import Step, StepResult
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


class _GatedDispatcher:
    """Blocks the single step in EXECUTING until `release` is set, so a test
    can subscribe to /events while the run is still in flight and control
    exactly when the terminal record gets journaled+published."""

    def __init__(self, release: asyncio.Event):
        self.release = release

    async def __call__(self, step: Step) -> StepResult:
        await self.release.wait()
        return StepResult(step.id, "pass", tokens_spent=100, evidence={"attempt": step.attempts})


@pytest.mark.asyncio
async def test_events_stream_live_delivers_terminal_record(tmp_path):
    """Exercises the live (not-yet-completed) streaming path: the SSE
    connection subscribes while the run is still executing, and only then is
    the run allowed to finish. This covers registry.subscribe()/the live
    queue loop and asserts the client receives the full, exact, in-order
    record sequence with no drops or duplicates. It does NOT pin the
    replay-vs-subscribe ordering itself (wall-clock polling can't force that
    race deterministically) — see
    test_events_stream_subscribes_before_reading_journal_file for the actual
    ordering-invariant regression guard."""
    app.state.data_dir = str(tmp_path)
    release = asyncio.Event()
    app.state.dispatcher_factory = lambda intent, budget, agent_name: _GatedDispatcher(release)
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        start = await client.post("/runs", json={
            "goal": "g", "acceptance_criteria": [], "baseline_ref": "0" * 40,
            "worktree": str(tmp_path / "wt"), "token_ceiling": 100_000, "max_attempts": 3,
        })
        run_id = start.json()["run_id"]
        entry = app.state.registry.get(run_id)

        events: list[dict] = []

        async def consume() -> None:
            async with client.stream("GET", f"/runs/{run_id}/events") as resp:
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        record = json.loads(line[len("data: "):])
                        events.append(record)
                        if record["to"] == "passed":
                            break

        consumer = asyncio.create_task(consume())

        # Wait until the SSE generator has actually subscribed (i.e. is past
        # the replay-then-subscribe gap that used to be racy) before letting
        # the step finish. The step is still EXECUTING at this point — the
        # journal only has blocked->ready->dispatched->executing so far —
        # so this test genuinely covers the live-queue delivery path, not
        # just replay-of-a-finished-run.
        for _ in range(500):
            if entry.subscribers:
                break
            await asyncio.sleep(0.01)
        assert entry.subscribers, "SSE stream never subscribed while the run was still executing"
        assert entry.task is not None and not entry.task.done()

        release.set()

        await asyncio.wait_for(consumer, timeout=5)
        await asyncio.wait_for(entry.task, timeout=5)

    assert events, "no events observed"
    assert events[-1]["to"] == "passed"
    with open(str(tmp_path / run_id / "journal.jsonl")) as f:
        journaled = [json.loads(line) for line in f if line.strip()]
    assert events == journaled


@pytest.mark.asyncio
async def test_events_stream_subscribes_before_reading_journal_file(tmp_path, monkeypatch):
    """Regression test for the replay-then-subscribe race fixed in `gen()`
    (see the fix report in .superpowers/sdd/plan5-task-4-report.md).

    The buggy version of `gen()` replayed the on-disk journal to EOF, checked
    `entry.task.done()`, and only *then* called `registry.subscribe()`. That
    left a window — between finishing the file read and subscribing — where a
    record journaled+published by the orchestrator would land in neither the
    (already-read) file nor a (not-yet-created) subscriber queue, and be
    silently dropped. The fix reorders this to subscribe first.

    `test_events_stream_live_delivers_terminal_record` above exercises the
    live-queue delivery path, but it cannot actually pin this specific
    ordering bug: journal replay of a handful of lines is near-instant, so no
    amount of wall-clock polling reliably forces a publish into that
    microscopic gap — the same test would pass identically against the old,
    buggy ordering, since it almost never manages to land the race. Instead of
    trying to force a timing race, this test asserts the ordering invariant
    directly and deterministically: `registry.subscribe()` must be called
    before the journal file is ever opened for replay. That invariant is
    exactly what the fix establishes and exactly what the old code violated
    (old code opened the file — and could return early without ever
    subscribing at all, if the run had already finished — before subscribing).
    """
    app.state.data_dir = str(tmp_path)
    transport = ASGITransport(app=app)

    order: list[str] = []
    real_open = builtins.open

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        start = await client.post("/runs", json={
            "goal": "g", "acceptance_criteria": [], "baseline_ref": "0" * 40,
            "worktree": str(tmp_path / "wt"), "token_ceiling": 100_000, "max_attempts": 3,
        })
        run_id = start.json()["run_id"]
        entry = app.state.registry.get(run_id)
        await asyncio.wait_for(entry.task, timeout=5)

        original_subscribe = app.state.registry.subscribe

        def tracking_subscribe(rid):
            order.append("subscribe")
            return original_subscribe(rid)

        def tracking_open(path, *args, **kwargs):
            # JsonlJournal.append() holds its own file handle opened once in
            # write ("a") mode at run-start time (see journal.py), so the
            # only bare `open(path)` (read mode, no explicit mode arg) call
            # against this run's journal file is the replay in gen().
            if (
                isinstance(path, str)
                and path == entry.journal.path
                and not args
                and "mode" not in kwargs
            ):
                order.append("open")
            return real_open(path, *args, **kwargs)

        monkeypatch.setattr(app.state.registry, "subscribe", tracking_subscribe)
        monkeypatch.setattr(builtins, "open", tracking_open)

        async with client.stream("GET", f"/runs/{run_id}/events") as resp:
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    break

    assert order == ["subscribe", "open"], (
        f"expected registry.subscribe() before the journal file is opened for "
        f"replay, got order={order}"
    )
