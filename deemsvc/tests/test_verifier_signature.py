from deemsvc.verifier.engine import Transition, TestDelta, VerifierEngine


def test_identical_failures_produce_identical_signatures():
    a = [TestDelta("t1", Transition.REGRESSION, "KeyError: x at cache.py:118")]
    b = [TestDelta("t1", Transition.REGRESSION, "KeyError: x at cache.py:118")]
    assert VerifierEngine._failure_signature(a, [], []) == VerifierEngine._failure_signature(b, [], [])


def test_different_trace_addresses_normalize_to_the_same_signature():
    a = [TestDelta("t1", Transition.REGRESSION, "KeyError at 0x7f3a1c2b3d4e cache.py:118")]
    b = [TestDelta("t1", Transition.REGRESSION, "KeyError at 0x00998877aabb cache.py:118")]
    assert VerifierEngine._failure_signature(a, [], []) == VerifierEngine._failure_signature(b, [], [])


def test_different_line_numbers_normalize_to_the_same_signature():
    a = [TestDelta("t1", Transition.REGRESSION, "AssertionError at cache.py:118")]
    b = [TestDelta("t1", Transition.REGRESSION, "AssertionError at cache.py:203")]
    assert VerifierEngine._failure_signature(a, [], []) == VerifierEngine._failure_signature(b, [], [])


def test_different_tmp_paths_normalize_to_the_same_signature():
    a = [TestDelta("t1", Transition.REGRESSION, "FileNotFoundError: /tmp/run-8821/x.txt")]
    b = [TestDelta("t1", Transition.REGRESSION, "FileNotFoundError: /tmp/run-9932/x.txt")]
    assert VerifierEngine._failure_signature(a, [], []) == VerifierEngine._failure_signature(b, [], [])


def test_different_failing_test_produces_a_different_signature():
    a = [TestDelta("t1", Transition.REGRESSION, "AssertionError")]
    b = [TestDelta("t2", Transition.REGRESSION, "AssertionError")]
    assert VerifierEngine._failure_signature(a, [], []) != VerifierEngine._failure_signature(b, [], [])


def test_unmet_criteria_affect_the_signature():
    sig_none = VerifierEngine._failure_signature([], [], [])
    sig_one = VerifierEngine._failure_signature([], [], ["AC-3"])
    assert sig_none != sig_one


def test_signature_is_a_16_char_hex_string():
    sig = VerifierEngine._failure_signature([], [], [])
    assert len(sig) == 16
    int(sig, 16)
