import pytest

from deemsvc.sdk.adapter import AgentAdapter
from deemsvc.sdk.cli_adapter import CliAgentAdapter
from deemsvc.sdk.dispatch import FableDispatcher
from deemsvc.sdk.registry import ADAPTER_FACTORIES, AdapterContext, build_adapter


def test_every_registered_factory_produces_an_agent_adapter():
    for name in ADAPTER_FACTORIES:
        adapter = build_adapter(name, AdapterContext(client=object(), run_root="."))
        assert isinstance(adapter, AgentAdapter)


def test_unknown_name_raises_with_known_names_listed():
    with pytest.raises(ValueError, match="claude-code-cli"):
        build_adapter("nonexistent", AdapterContext())


def test_fable5_native_passes_through_client_and_run_root():
    ctx = AdapterContext(client="fake-client", run_root="/tmp/x")
    adapter = build_adapter("fable5-native", ctx)
    assert isinstance(adapter, FableDispatcher)
    assert adapter.client == "fake-client"
    assert adapter.run_root == "/tmp/x"


def test_claude_code_cli_factory_ignores_the_client_field():
    ctx = AdapterContext(client=None, run_root=".")
    adapter = build_adapter("claude-code-cli", ctx)
    assert isinstance(adapter, CliAgentAdapter)
    assert adapter.spec.name == "claude-code-cli"
    assert adapter.spec.argv[0] == "claude"


def test_codex_cli_factory_produces_the_codex_spec():
    adapter = build_adapter("codex-cli", AdapterContext())
    assert isinstance(adapter, CliAgentAdapter)
    assert adapter.spec.name == "codex-cli"
    assert adapter.spec.argv[0] == "codex"
