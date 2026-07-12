from __future__ import annotations

from dataclasses import dataclass

# Fable 5 minimum cacheable prefix is 2048 tokens (lower than Opus 4.8's 4096).
# The frozen system prompt sits before this breakpoint; volatile per-step
# context goes after it, so the tool list + persona cache across every step.
_CACHE = {"type": "ephemeral"}


@dataclass(frozen=True)
class RoleProfile:
    effort: str                       # "low" | "high" | "xhigh" | "max"
    stream: bool
    surface_reasoning: bool           # verifier: True — reasoning enters the audit trail
    task_budget_tokens: int | None    # None => no self-pacing countdown
    long_horizon: bool                # generators/planners => enable compaction + editing


PROFILES: dict[str, RoleProfile] = {
    "explorer":  RoleProfile("low",   False, False, None,   False),
    "generator": RoleProfile("xhigh", True,  False, 90_000, True),
    "verifier":  RoleProfile("high",  True,  True,  None,   False),
    "planner":   RoleProfile("xhigh", True,  True,  60_000, True),
}


def build_request(
    role: str,
    system_blocks: list[dict],        # frozen persona (cached) + pinned criteria
    messages: list[dict],
    tools: list[dict],
    max_tokens: int = 64_000,
) -> tuple[dict, list[str]]:
    """Returns (kwargs, betas). Encodes every Fable 5 rule in one place so no
    call site can drift: no thinking config unless surfacing reasoning, effort
    in output_config, no sampling params, fallbacks always on. Used only by the
    FableDispatcher adapter (Task 5) — CLI adapters (Task 6) don't call this."""
    p = PROFILES[role]
    betas = ["server-side-fallback-2026-06-01"]

    output_config: dict = {"effort": p.effort}
    if p.task_budget_tokens is not None:
        # Fable 5 sees a running countdown and self-moderates. Minimum 20_000.
        output_config["task_budget"] = {"type": "tokens", "total": p.task_budget_tokens}
        betas.append("task-budgets-2026-03-13")

    kwargs: dict = {
        "model": "claude-fable-5",
        "max_tokens": max_tokens,               # 128K ceiling; stream above ~16K
        "system": system_blocks,
        "messages": messages,
        "tools": tools,
        "output_config": output_config,
        # Recover the previously-cached span at cache-read rates if a refusal
        # forces a fallback to Opus 4.8 (per-model caches are otherwise cold).
        "fallbacks": [{"model": "claude-opus-4-8"}],
        # NO thinking key unless we surface reasoning — omitting it keeps
        # adaptive thinking on (the default) with empty-text thinking blocks.
        # NO temperature / top_p / top_k — they 400 on Fable 5.
    }
    if p.surface_reasoning:
        kwargs["thinking"] = {"type": "adaptive", "display": "summarized"}
    if p.long_horizon:
        # Compaction summarizes history near the context ceiling; context editing
        # clears stale twin-worktree tool results the model no longer needs.
        betas += ["compact-2026-01-12", "context-management-2025-06-27"]
        kwargs["context_management"] = {
            "edits": [
                {"type": "clear_tool_uses_20250919"},
                {"type": "compact_20260112"},
            ],
        }
    return kwargs, betas
