from deemsvc.sdk.request import PROFILES, build_request


def test_explorer_has_no_thinking_key_and_no_task_budget():
    kwargs, betas = build_request("explorer", [], [], [])
    assert "thinking" not in kwargs
    assert "task_budget" not in kwargs["output_config"]
    assert kwargs["output_config"]["effort"] == "low"


def test_generator_has_task_budget_and_compaction_but_no_surfaced_reasoning():
    kwargs, betas = build_request("generator", [], [], [])
    assert "thinking" not in kwargs
    assert kwargs["output_config"]["task_budget"] == {"type": "tokens", "total": 90_000}
    assert "task-budgets-2026-03-13" in betas
    assert "compact-2026-01-12" in betas
    assert "context-management-2025-06-27" in betas
    assert kwargs["output_config"]["effort"] == "xhigh"


def test_verifier_surfaces_summarized_reasoning():
    kwargs, betas = build_request("verifier", [], [], [])
    assert kwargs["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert kwargs["output_config"]["effort"] == "high"


def test_every_role_always_carries_the_opus_fallback():
    for role in PROFILES:
        kwargs, _ = build_request(role, [], [], [])
        assert kwargs["fallbacks"] == [{"model": "claude-opus-4-8"}]


def test_no_sampling_parameters_are_ever_set():
    for role in PROFILES:
        kwargs, _ = build_request(role, [], [], [])
        assert "temperature" not in kwargs
        assert "top_p" not in kwargs
        assert "top_k" not in kwargs


def test_model_is_always_fable_5():
    for role in PROFILES:
        kwargs, _ = build_request(role, [], [], [])
        assert kwargs["model"] == "claude-fable-5"


def test_server_side_fallback_beta_is_always_present():
    for role in PROFILES:
        _, betas = build_request(role, [], [], [])
        assert "server-side-fallback-2026-06-01" in betas


def test_system_messages_and_tools_pass_through_unchanged():
    system = [{"type": "text", "text": "persona"}]
    messages = [{"role": "user", "content": "hi"}]
    tools = [{"name": "run_tests"}]
    kwargs, _ = build_request("generator", system, messages, tools)
    assert kwargs["system"] == system
    assert kwargs["messages"] == messages
    assert kwargs["tools"] == tools
