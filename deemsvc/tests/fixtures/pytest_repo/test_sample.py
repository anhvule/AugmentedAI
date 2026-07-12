def test_passes():
    assert 1 + 1 == 2


def test_fails():
    assert 1 + 1 == 3, "arithmetic is broken"


def test_skipped():
    import pytest
    pytest.skip("not applicable")
