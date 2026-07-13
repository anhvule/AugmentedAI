from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from deemsvc.orchestrator.journal import JsonlJournal
from deemsvc.orchestrator.state import Intent, Step, TokenBudget


@dataclass
class RunEntry:
    run_id: str
    graph: dict[str, Step]
    task: asyncio.Task | None
    journal: JsonlJournal
    intent: Intent                      # pinned at run start — resume reuses it, never fabricates
    budget: TokenBudget                 # same object across resume — preserves consumed accounting
    agent: str = "fable5-native"        # which AgentAdapter this run uses — resume reuses it
    subscribers: set[asyncio.Queue] = field(default_factory=set)


class RunRegistry:
    def __init__(self):
        self._runs: dict[str, RunEntry] = {}

    def create(self, run_id: str, graph: dict[str, Step], journal: JsonlJournal,
              intent: Intent, budget: TokenBudget,
              agent: str = "fable5-native") -> RunEntry:
        entry = RunEntry(run_id=run_id, graph=graph, task=None, journal=journal,
                         intent=intent, budget=budget, agent=agent)
        self._runs[run_id] = entry
        return entry

    def get(self, run_id: str) -> RunEntry | None:
        return self._runs.get(run_id)

    def publish(self, run_id: str, record: dict) -> None:
        entry = self._runs.get(run_id)
        if not entry:
            return
        for queue in entry.subscribers:
            queue.put_nowait(record)

    def subscribe(self, run_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        entry = self._runs[run_id]
        entry.subscribers.add(queue)
        return queue

    def unsubscribe(self, run_id: str, queue: asyncio.Queue) -> None:
        entry = self._runs.get(run_id)
        if entry:
            entry.subscribers.discard(queue)
