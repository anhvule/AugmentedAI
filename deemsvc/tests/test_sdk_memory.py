import pytest

from deemsvc.sdk.memory import MemoryStore


def test_create_then_view_round_trips(tmp_path):
    store = MemoryStore(str(tmp_path))
    store.handle({"command": "create", "path": "/memories/note.md", "file_text": "line1\nline2\n"})
    result = store.handle({"command": "view", "path": "/memories/note.md"})
    assert "line1" in result and "line2" in result


def test_str_replace_requires_exactly_one_match(tmp_path):
    store = MemoryStore(str(tmp_path))
    store.handle({"command": "create", "path": "/memories/note.md", "file_text": "a\nb\na\n"})
    result = store.handle({"command": "str_replace", "path": "/memories/note.md",
                           "old_str": "a", "new_str": "z"})
    assert result.startswith("error")  # "a" appears twice


def test_str_replace_succeeds_on_a_unique_match(tmp_path):
    store = MemoryStore(str(tmp_path))
    store.handle({"command": "create", "path": "/memories/note.md", "file_text": "unique\nb\n"})
    result = store.handle({"command": "str_replace", "path": "/memories/note.md",
                           "old_str": "unique", "new_str": "changed"})
    assert result == "ok"
    assert "changed" in store.handle({"command": "view", "path": "/memories/note.md"})


def test_delete_removes_a_file(tmp_path):
    store = MemoryStore(str(tmp_path))
    store.handle({"command": "create", "path": "/memories/gone.md", "file_text": "x"})
    store.handle({"command": "delete", "path": "/memories/gone.md"})
    result = store.handle({"command": "view", "path": "/memories"})
    assert "gone.md" not in result


def test_rename_moves_a_file(tmp_path):
    store = MemoryStore(str(tmp_path))
    store.handle({"command": "create", "path": "/memories/old.md", "file_text": "x"})
    result = store.handle({"command": "rename", "path": "/memories/old.md",
                           "old_path": "/memories/old.md", "new_path": "/memories/new.md"})
    assert "renamed" in result
    assert "new.md" in store.handle({"command": "view", "path": "/memories"})


def test_path_escape_attempt_is_rejected(tmp_path):
    store = MemoryStore(str(tmp_path))
    with pytest.raises(ValueError, match="escapes memory root"):
        store.handle({"command": "create", "path": "/memories/../../etc/passwd",
                     "file_text": "pwned"})


def test_view_of_a_directory_lists_entries(tmp_path):
    store = MemoryStore(str(tmp_path))
    store.handle({"command": "create", "path": "/memories/a.md", "file_text": "x"})
    store.handle({"command": "create", "path": "/memories/b.md", "file_text": "x"})
    result = store.handle({"command": "view", "path": "/memories"})
    assert "a.md" in result and "b.md" in result


def test_insert_adds_a_line_at_the_given_position(tmp_path):
    store = MemoryStore(str(tmp_path))
    store.handle({"command": "create", "path": "/memories/n.md", "file_text": "first\nthird\n"})
    store.handle({"command": "insert", "path": "/memories/n.md", "insert_line": 1,
                 "insert_text": "second"})
    result = store.handle({"command": "view", "path": "/memories/n.md"})
    assert result.splitlines()[1].endswith("second")
