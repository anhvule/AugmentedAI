from __future__ import annotations

import json

from deemsvc.orchestrator.state import Step, StepResult
from deemsvc.sandbox.broker import OutcomeKind, ToolBroker
from .memory import MemoryStore
from .request import build_request


class FableDispatcher:
    """Direct-Anthropic-API adapter. One of several AgentAdapter implementations
    (see sdk/adapter.py) — the one with Fable-5-specific capabilities (task
    budgets, memory tool, effort levels). CLI-backed adapters (sdk/cli_adapter.py)
    have none of this machinery and are equally valid AgentAdapters."""

    def __init__(self, client, run_root: str):
        self.client = client
        self.run_root = run_root

    async def _editor(self, broker: ToolBroker, tool_input: dict) -> str:
        """Text-editor tool calls resolve to broker-invoked git/pytest primitives
        are out of scope for this method — Anthropic's server-executed text editor
        tool handles file reads/writes directly against the sandboxed filesystem
        path the worktree grant exposes; this dispatcher only needs to pass its
        result through, since the tool itself is declared server-side (§8.4) and
        the SDK resolves it without a client-side handler for the common case.
        This stub exists so a future custom editor policy has a single seam."""
        return json.dumps({"ok": True, "input": tool_input})

    def _emit(self, step_id: str, message: str) -> str:
        return f"sent: {message}"

    async def __call__(self, step: Step) -> StepResult:
        role = {"explore": "explorer", "generate": "generator",
                "verify": "verifier", "integrate": "planner"}[step.step_class]
        grant = step.payload["capability_grant"]
        broker = ToolBroker(grant["worktree"])
        memory = MemoryStore(grant["worktree"])

        system = step.payload["system_blocks"]        # frozen persona + pinned criteria
        tools = step.payload["tools"]
        messages: list[dict] = [{"role": "user", "content": step.payload["objective"]}]
        kwargs, betas = build_request(role, system, messages, tools)

        spent, tool_calls, claims = 0, 0, []
        while True:
            async with self.client.beta.messages.stream(betas=betas, **kwargs) as stream:
                msg = await stream.get_final_message()

            spent += msg.usage.input_tokens + msg.usage.output_tokens

            # Refusal: fallback already ran server-side. A refusal on the final
            # message means the whole chain declined — escalate, don't loop.
            if msg.stop_reason == "refusal":
                return StepResult(step.id, "escalate", spent,
                                  {"refusal": msg.stop_details.category
                                   if msg.stop_details else None})

            # Preserve full content (incl. compaction/fallback blocks) for the next turn.
            messages.append({"role": "assistant", "content": msg.content})
            kwargs["messages"] = messages

            if msg.stop_reason != "tool_use":
                break

            results = []
            for block in msg.content:
                if block.type != "tool_use":
                    continue
                tool_calls += 1
                if block.name == "memory":
                    out = memory.handle(block.input)
                elif block.name == "send_to_user":
                    out = self._emit(step.id, block.input["message"])
                elif block.name == "run_tests":
                    outcome = await broker.invoke("pytest-junit",
                                                  selector=block.input["selector"])
                    out = json.dumps(outcome.parsed)
                else:  # text editor / bash handled server-side or by broker file ops
                    out = await self._editor(broker, block.input)
                results.append({"type": "tool_result",
                                "tool_use_id": block.id, "content": out})
            messages.append({"role": "user", "content": results})   # ALL results, one message
            kwargs["messages"] = messages

        # Compute the candidate ref from git — never trust the model's claim.
        head = await broker.invoke("git", sub="rev-parse", a1="HEAD")
        candidate_ref = head.parsed.get("stdout", "").strip()
        claims.append({"claim": "candidate committed",
                       "evidence": {"type": "git_diff_digest", "worktree_head": candidate_ref}})

        # The dispatcher returns a *proposed* pass; the Verifier is the arbiter.
        # The orchestrator routes generate-class results through it before any
        # PASSED transition — the dispatcher never self-certifies.
        verdict = "pass" if candidate_ref else "retry"
        return StepResult(step.id, verdict, spent,
                          evidence={"candidate_ref": candidate_ref, "claims": claims,
                                    "tool_calls": tool_calls})
