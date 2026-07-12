from .memory import MEMORY_TOOL

GENERATOR_TOOLS: list[dict] = [
    {
        "name": "run_tests",
        "description": (
            "Run the pytest suite or a selector inside your worktree. Call this "
            "after every edit that could affect behavior, and before reporting "
            "any test-related progress. Returns the parsed pass/fail matrix."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "pytest node id or path, e.g. tests/test_cache.py",
                },
            },
            "required": ["selector"],
            "additionalProperties": False,
        },
    },
    {
        "name": "send_to_user",
        "description": (
            "Display a message to the operator exactly as written. Use for a "
            "progress figure, a partial result, or a direct answer the operator "
            "must see before the task finishes. Content is never summarized."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {"message": {"type": "string"}},
            "required": ["message"],
            "additionalProperties": False,
        },
    },
    # Anthropic-defined text editor + bash are declared schema-less, by type only:
    {"type": "text_editor_20250728", "name": "str_replace_based_edit_tool"},
    MEMORY_TOOL,
]
