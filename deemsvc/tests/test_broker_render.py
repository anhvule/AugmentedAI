import pytest

from deemsvc.sandbox.broker import REGISTRY, ToolBroker


def test_render_substitutes_placeholders():
    broker = ToolBroker("/tmp")
    argv = broker._render(REGISTRY["git"], {"sub": "rev-parse", "a1": "HEAD"})
    assert argv == ["git", "rev-parse", "HEAD"]


def test_render_omits_unset_optional_placeholders():
    broker = ToolBroker("/tmp")
    argv = broker._render(REGISTRY["git"], {"sub": "status"})
    assert argv == ["git", "status"]


def test_render_omits_empty_string_placeholders():
    broker = ToolBroker("/tmp")
    argv = broker._render(REGISTRY["git"], {"sub": "log", "a1": "", "a2": "-1"})
    assert argv == ["git", "log", "-1"]


def test_render_rejects_unsafe_characters():
    broker = ToolBroker("/tmp")
    with pytest.raises(ValueError, match="unsafe argument"):
        broker._render(REGISTRY["git"], {"sub": "log; rm -rf /"})


def test_render_allows_the_full_safe_character_class():
    broker = ToolBroker("/tmp")
    # letters, digits, underscore, dot, colon, slash, @, =, dash, brackets
    argv = broker._render(REGISTRY["git"], {"sub": "diff", "a1": "HEAD~1..HEAD",
                                            "a2": "--", "a3": "path/to/file.py"})
    assert argv == ["git", "diff", "HEAD~1..HEAD", "--", "path/to/file.py"]
