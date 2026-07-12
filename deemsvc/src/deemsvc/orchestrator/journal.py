from __future__ import annotations

import json
import os

from .state import Step, StepStatus


class JsonlJournal:
    """Write-ahead event log. Every Orchestrator transition is appended here
    before it takes effect (see state.py:Orchestrator._transition), so a crash
    mid-run leaves either a complete or a missing final line — never a corrupt one."""

    def __init__(self, path: str):
        self.path = path
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self._fh = open(path, "a", buffering=1)

    def append(self, record: dict) -> None:
        self._fh.write(json.dumps(record, sort_keys=True, default=str) + "\n")
        self._fh.flush()
        os.fsync(self._fh.fileno())

    def close(self) -> None:
        self._fh.close()

    @staticmethod
    def replay(path: str) -> dict[str, StepStatus]:
        """Last recorded status per step id, in journal order."""
        if not os.path.exists(path):
            return {}
        last: dict[str, str] = {}
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                last[rec["step"]] = rec["to"]
        return {step_id: StepStatus(status) for step_id, status in last.items()}


_INFLIGHT = frozenset({
    StepStatus.DISPATCHED, StepStatus.EXECUTING, StepStatus.VERIFYING, StepStatus.RETRYING,
})


def resume_graph(graph: dict[str, Step], journal_path: str) -> None:
    """Apply the last recorded status from `journal_path` onto `graph` in place.

    Terminal statuses (PASSED, ABANDONED, ESCALATED) are restored as-is. In-flight
    statuses are reset to BLOCKED rather than the blueprint's literal "re-enter READY":
    resetting to BLOCKED and letting Orchestrator._frontier() recompute READY from
    current dependency state is the only way to guarantee a step already missing a
    passed dependency isn't dispatched again — the same safety Orchestrator.run()
    already relies on for the ordinary (non-crash) frontier walk.
    """
    statuses = JsonlJournal.replay(journal_path)
    for step_id, status in statuses.items():
        if step_id not in graph:
            continue
        graph[step_id].status = StepStatus.BLOCKED if status in _INFLIGHT else status
