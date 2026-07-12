from __future__ import annotations

import asyncio
import os
import uuid

from fastapi import FastAPI
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
