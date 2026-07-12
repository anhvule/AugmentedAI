from __future__ import annotations

import asyncio
import json
import os
import signal
from dataclasses import dataclass
from typing import Literal

from deemsvc.orchestrator.state import Step, StepResult
from deemsvc.sandbox.broker import OutcomeKind, ToolBroker


@dataclass(frozen=True)
class CliAdapterSpec:
    """Fixed argv template + prompt-delivery convention for one CLI-based
    coding agent. Adding a fourth CLI tool means adding a fourth CliAdapterSpec
    instance in registry.py — never a new adapter class."""
    name: str
    argv: tuple[str, ...]           # e.g. ("claude", "-p", "--output-format", "stream-json")
    prompt_via: Literal["stdin", "arg"]   # how the objective text is delivered
    timeout_s: int = 1800


class CliAgentAdapter:
    """Implements AgentAdapter by shelling out to an installed CLI coding tool.
    Same invariant as FableDispatcher: the CLI's own transcript/self-report is
    never trusted — candidate_ref always comes from `git rev-parse HEAD` via
    ToolBroker, computed after the subprocess exits, regardless of what the CLI
    printed. This is what lets CLI-backed generation be routed through
    GenerateThenVerifyDispatcher's Verifier arbitration exactly like Fable 5
    native generation does — the Verifier only ever needs a git ref."""

    def __init__(self, spec: CliAdapterSpec):
        self.spec = spec

    async def __call__(self, step: Step) -> StepResult:
        grant = step.payload["capability_grant"]
        worktree = grant["worktree"]
        objective = step.payload["objective"]

        argv = list(self.spec.argv)
        if self.spec.prompt_via == "arg":
            argv.append(objective)

        # Baseline HEAD, captured before the CLI runs: `git rev-parse HEAD`
        # succeeds on any worktree that already has a commit, so a bare
        # post-run rev-parse can't distinguish "the CLI committed a candidate"
        # from "the CLI did nothing and HEAD is still whatever it was." Only a
        # HEAD that *moved* counts as a candidate — see DEVIATION note below.
        broker = ToolBroker(worktree)
        baseline = await broker.invoke("git", sub="rev-parse", a1="HEAD")
        baseline_ref = baseline.parsed.get("stdout", "").strip() if baseline.kind is OutcomeKind.TOOL_OK else ""

        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=worktree, env=env,
            stdin=asyncio.subprocess.PIPE if self.spec.prompt_via == "stdin" else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        if self.spec.prompt_via == "stdin":
            proc.stdin.write(objective.encode())
            await proc.stdin.drain()
            proc.stdin.close()

        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=self.spec.timeout_s)
        except asyncio.TimeoutError:
            os.killpg(proc.pid, signal.SIGKILL)
            await proc.wait()
            return StepResult(step.id, "retry", 0,
                              evidence={"candidate_ref": "",
                                       "error": f"{self.spec.name} timed out after {self.spec.timeout_s}s"})

        tool_calls = 0
        for line in stdout.decode(errors="replace").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "tool_use":
                tool_calls += 1

        head = await broker.invoke("git", sub="rev-parse", a1="HEAD")
        current_ref = head.parsed.get("stdout", "").strip() if head.kind is OutcomeKind.TOOL_OK else ""
        candidate_ref = current_ref if current_ref and current_ref != baseline_ref else ""

        # Never trust the CLI's own success claim — only a real *new* commit counts.
        verdict = "pass" if candidate_ref else "retry"
        return StepResult(step.id, verdict, tokens_spent=0,  # CLIs don't report usage uniformly
                          evidence={"candidate_ref": candidate_ref, "tool_calls": tool_calls,
                                   "cli": self.spec.name})
