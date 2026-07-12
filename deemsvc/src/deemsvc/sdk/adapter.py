from __future__ import annotations

from typing import Protocol, runtime_checkable

from deemsvc.orchestrator.state import Step, StepResult


@runtime_checkable
class AgentAdapter(Protocol):
    """The one contract every pluggable agent backend must satisfy — the same
    Callable[[Step], Awaitable[StepResult]] shape Orchestrator.dispatch and
    GenerateThenVerifyDispatcher already expect. FableDispatcher (Task 5) and
    CliAgentAdapter (Task 6) are the two concrete implementations this plan
    ships; a third backend is a third class satisfying this same __call__
    signature registered in ADAPTER_FACTORIES (Task 7) — no other file in
    deemsvc needs to change.

    Invariant every implementation must uphold (see Global Constraints):
    candidate_ref is always computed from `git rev-parse HEAD` after the
    agent's work is done, never parsed from the agent's own output.
    """

    async def __call__(self, step: Step) -> StepResult: ...
