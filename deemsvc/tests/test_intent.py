import pytest

from deemsvc.orchestrator.state import Intent


def _intent(**overrides) -> Intent:
    defaults = dict(
        goal="Make ProjectionCache invalidate on schema migration",
        acceptance_criteria=("AC-3: cache keyed by schema_version",),
        protected_paths=("migrations/",),
        forbidden_actions=("force-push",),
        baseline_ref="abc123",
    )
    defaults.update(overrides)
    return Intent(**defaults)


def test_intent_is_frozen():
    intent = _intent()
    with pytest.raises(AttributeError):
        intent.goal = "different goal"  # type: ignore[misc]


def test_digest_is_stable_for_identical_intent():
    assert _intent().digest == _intent().digest


def test_digest_changes_when_any_field_changes():
    base = _intent().digest
    assert _intent(goal="different goal").digest != base
    assert _intent(baseline_ref="def456").digest != base
    assert _intent(acceptance_criteria=("AC-4",)).digest != base


def test_digest_is_a_16_char_hex_string():
    digest = _intent().digest
    assert len(digest) == 16
    int(digest, 16)  # raises ValueError if not hex
