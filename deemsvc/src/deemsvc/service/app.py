from __future__ import annotations

import asyncio
import json
import os
import uuid
from collections import Counter

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from deemsvc.orchestrator.journal import JsonlJournal
from deemsvc.orchestrator.state import Intent, Orchestrator, Step, TokenBudget

from .registry import RunRegistry

app = FastAPI(title="deemsvc")
app.state.registry = RunRegistry()


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


class StartRunRequest(BaseModel):
    goal: str
    acceptance_criteria: list[str]
    baseline_ref: str
    worktree: str
    token_ceiling: int = 500_000
    max_attempts: int = 4
    agent: str = "fable5-native"    # any name in deemsvc.sdk.registry.ADAPTER_FACTORIES


def _default_dispatcher_factory(intent: Intent, budget: TokenBudget, agent_name: str):
    """Production factory — builds whichever AgentAdapter `agent_name` selects
    (see deemsvc-fable5-dispatcher's registry.py), composed with the Verifier.
    Overridden in tests via app.state.dispatcher_factory so the test suite never
    calls the Anthropic API or spawns a real CLI."""
    from anthropic import AsyncAnthropic

    from deemsvc.sdk.registry import AdapterContext, build_adapter
    from deemsvc.service.dispatch import GenerateThenVerifyDispatcher
    from deemsvc.verifier.engine import VerifierEngine

    client = AsyncAnthropic()
    agent = build_adapter(agent_name, AdapterContext(client=client, run_root="."))
    return GenerateThenVerifyDispatcher(
        agent, verifier_factory=lambda repo_root: VerifierEngine(repo_root, client=client),
        intent=intent, budget=budget,
    )


app.state.dispatcher_factory = _default_dispatcher_factory
app.state.data_dir = os.environ.get("DEEMSVC_DATA_DIR", "data/runs")


@app.post("/runs")
async def start_run(req: StartRunRequest) -> dict:
    run_id = uuid.uuid4().hex[:12]
    intent = Intent(goal=req.goal, acceptance_criteria=tuple(req.acceptance_criteria),
                    protected_paths=(), forbidden_actions=(), baseline_ref=req.baseline_ref)
    budget = TokenBudget(ceiling=req.token_ceiling)
    graph = {
        "impl": Step(id="impl", step_class="generate",
                    payload={"capability_grant": {"worktree": req.worktree},
                            "objective": req.goal, "system_blocks": [], "tools": []},
                    deps=frozenset(), max_attempts=req.max_attempts),
    }

    journal_path = os.path.join(app.state.data_dir, run_id, "journal.jsonl")
    journal = JsonlJournal(journal_path)
    entry = app.state.registry.create(run_id, graph, journal, agent=req.agent)

    def journal_and_publish(record: dict) -> None:
        journal.append(record)
        app.state.registry.publish(run_id, record)

    dispatch = app.state.dispatcher_factory(intent, budget, req.agent)
    orchestrator = Orchestrator(intent, budget, dispatch, journal_and_publish)
    entry.task = asyncio.create_task(orchestrator.run(graph))
    return {"run_id": run_id}


@app.get("/runs/{run_id}/events")
async def stream_events(run_id: str) -> StreamingResponse:
    entry = app.state.registry.get(run_id)
    if entry is None:
        raise HTTPException(404, "unknown run_id")

    async def gen():
        # Subscribe BEFORE replaying the on-disk journal. The generator yields
        # control back to the event loop on every `yield` (the ASGI layer
        # flushes each chunk), so if we replayed the file first and only
        # subscribed afterwards, a record — including the terminal
        # passed/abandoned/escalated one — could be journaled+published in
        # that gap and be missed entirely: not on disk in time for replay,
        # and not delivered live because we weren't subscribed yet. By
        # subscribing first, any record published during replay is already
        # queued for us; we just need to de-dup it against what we replay
        # from disk, since the producer journals a record to disk *before*
        # publishing it (see journal_and_publish in start_run), so the same
        # record can land in both places.
        queue = app.state.registry.subscribe(run_id)
        try:
            replayed_counts: Counter[str] = Counter()
            with open(entry.journal.path) as f:
                for line in f:
                    line = line.strip()
                    if line:
                        replayed_counts[line] += 1
                        yield f"data: {line}\n\n"

            # Drain anything that raced onto the queue while we were reading
            # the file, de-duping against what we just replayed from disk.
            while True:
                try:
                    record = queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                serialized = json.dumps(record, sort_keys=True, default=str)
                if replayed_counts[serialized] > 0:
                    replayed_counts[serialized] -= 1
                    continue
                yield f"data: {serialized}\n\n"

            if entry.task is not None and entry.task.done():
                return  # producer finished; nothing more will ever be published

            while True:
                record = await queue.get()
                serialized = json.dumps(record, sort_keys=True, default=str)
                if replayed_counts[serialized] > 0:
                    replayed_counts[serialized] -= 1
                    continue
                yield f"data: {serialized}\n\n"
                if record.get("to") in ("passed", "abandoned", "escalated") and (
                    entry.task is not None and entry.task.done()
                ):
                    break
        finally:
            app.state.registry.unsubscribe(run_id, queue)

    return StreamingResponse(gen(), media_type="text/event-stream")
