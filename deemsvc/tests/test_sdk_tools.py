import jsonschema
import pytest

from deemsvc.sdk.tools import GENERATOR_TOOLS


def test_every_custom_tool_is_strict():
    custom = [t for t in GENERATOR_TOOLS if "input_schema" in t]
    assert custom, "expected at least one custom (non-built-in) tool"
    for tool in custom:
        assert tool["strict"] is True


def test_run_tests_schema_requires_selector():
    run_tests = next(t for t in GENERATOR_TOOLS if t["name"] == "run_tests")
    jsonschema.validate({"selector": "tests/test_x.py"}, run_tests["input_schema"])
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({}, run_tests["input_schema"])


def test_run_tests_schema_rejects_unknown_properties():
    run_tests = next(t for t in GENERATOR_TOOLS if t["name"] == "run_tests")
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"selector": "x", "extra": "nope"}, run_tests["input_schema"])


def test_send_to_user_schema_requires_message():
    send = next(t for t in GENERATOR_TOOLS if t["name"] == "send_to_user")
    jsonschema.validate({"message": "hello"}, send["input_schema"])
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({}, send["input_schema"])


def test_built_in_tools_are_declared_by_type_only():
    editor = next(t for t in GENERATOR_TOOLS if t.get("type") == "text_editor_20250728")
    assert editor["name"] == "str_replace_based_edit_tool"
    assert "input_schema" not in editor


def test_memory_tool_is_included():
    memory = next(t for t in GENERATOR_TOOLS if t.get("type") == "memory_20250818")
    assert memory["name"] == "memory"
