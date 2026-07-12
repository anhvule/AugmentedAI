from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .adapter import AgentAdapter
from .cli_adapter import CliAdapterSpec, CliAgentAdapter
from .dispatch import FableDispatcher


@dataclass
class AdapterContext:
    """Everything a concrete adapter factory might need. Individual factories
    read only the fields they use — the CLI factories ignore `client` entirely,
    since they authenticate however the installed CLI is already configured."""
    client: object | None = None   # AsyncAnthropic — only fable5-native uses this
    run_root: str = "."


CLAUDE_CODE_CLI = CliAdapterSpec(
    name="claude-code-cli",
    argv=("claude", "-p", "--output-format", "stream-json"),
    prompt_via="stdin",
)
CODEX_CLI = CliAdapterSpec(
    name="codex-cli",
    argv=("codex", "exec", "--json"),
    prompt_via="arg",
)

ADAPTER_FACTORIES: dict[str, Callable[[AdapterContext], AgentAdapter]] = {
    "fable5-native": lambda ctx: FableDispatcher(ctx.client, ctx.run_root),
    "claude-code-cli": lambda ctx: CliAgentAdapter(CLAUDE_CODE_CLI),
    "codex-cli": lambda ctx: CliAgentAdapter(CODEX_CLI),
}


def build_adapter(name: str, ctx: AdapterContext) -> AgentAdapter:
    factory = ADAPTER_FACTORIES.get(name)
    if factory is None:
        raise ValueError(f"unknown agent adapter {name!r}. Known: {sorted(ADAPTER_FACTORIES)}")
    return factory(ctx)
