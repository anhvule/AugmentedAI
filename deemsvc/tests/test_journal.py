import json

from deemsvc.orchestrator.journal import JsonlJournal
from deemsvc.orchestrator.state import StepStatus


def test_append_writes_one_json_line_per_record(tmp_path):
    path = tmp_path / "run.jsonl"
    journal = JsonlJournal(str(path))
    journal.append({"step": "a", "from": "blocked", "to": "ready"})
    journal.append({"step": "a", "from": "ready", "to": "dispatched"})
    journal.close()

    lines = path.read_text().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["to"] == "ready"
    assert json.loads(lines[1])["to"] == "dispatched"


def test_replay_returns_last_status_per_step(tmp_path):
    path = tmp_path / "run.jsonl"
    journal = JsonlJournal(str(path))
    journal.append({"step": "a", "from": "blocked", "to": "ready"})
    journal.append({"step": "a", "from": "ready", "to": "dispatched"})
    journal.append({"step": "b", "from": "blocked", "to": "ready"})
    journal.close()

    statuses = JsonlJournal.replay(str(path))
    assert statuses == {"a": StepStatus.DISPATCHED, "b": StepStatus.READY}


def test_replay_of_missing_file_returns_empty_dict(tmp_path):
    assert JsonlJournal.replay(str(tmp_path / "does-not-exist.jsonl")) == {}


def test_replay_skips_blank_lines(tmp_path):
    path = tmp_path / "run.jsonl"
    path.write_text('{"step": "a", "from": "blocked", "to": "ready"}\n\n')
    assert JsonlJournal.replay(str(path)) == {"a": StepStatus.READY}
