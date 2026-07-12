import pytest

from deemsvc.verifier.engine import Transition, TestDelta, VerifierEngine


@pytest.fixture
def flake_repo(tmp_path):
    """A repo whose test_flaky.py fails on the first invocation only, by reading and
    incrementing a counter file — so `FLAKE_RERUNS=3` reruns see PASS at least once."""
    dest = tmp_path / "flake_repo"
    dest.mkdir()
    (dest / "pytest.ini").write_text("[pytest]\naddopts = -p no:cacheprovider\n")
    (dest / "counter.txt").write_text("0")
    (dest / "test_flaky.py").write_text(
        "import pathlib\n"
        "def test_flaky():\n"
        "    p = pathlib.Path(__file__).parent / 'counter.txt'\n"
        "    n = int(p.read_text())\n"
        "    p.write_text(str(n + 1))\n"
        "    assert n != 0  # fails only on the very first call\n"
        "def test_deterministic_failure():\n"
        "    assert False\n"
    )
    return dest


@pytest.mark.asyncio
async def test_flaky_regression_is_quarantined_not_confirmed(flake_repo):
    engine = VerifierEngine(str(flake_repo))
    # NOTE: test_id uses the dotted classname pytest's JUnit XML actually emits for a
    # top-level module ("test_flaky::test_flaky"), not an empty classname
    # ("::test_flaky") — see "Deviations from brief" in the task report.
    regressions = [TestDelta("test_flaky::test_flaky", Transition.REGRESSION, "assert n != 0")]
    confirmed, flaky = await engine._bleach_flakes(str(flake_repo), regressions)
    assert confirmed == []
    assert flaky == ["test_flaky::test_flaky"]


@pytest.mark.asyncio
async def test_deterministic_regression_is_confirmed(flake_repo):
    engine = VerifierEngine(str(flake_repo))
    regressions = [TestDelta("test_flaky::test_deterministic_failure", Transition.REGRESSION, "assert False")]
    confirmed, flaky = await engine._bleach_flakes(str(flake_repo), regressions)
    assert [d.test_id for d in confirmed] == ["test_flaky::test_deterministic_failure"]
    assert flaky == []
