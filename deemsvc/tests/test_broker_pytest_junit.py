import shutil

import pytest

from deemsvc.sandbox.broker import OutcomeKind, ToolBroker

FIXTURE = "tests/fixtures/pytest_repo"


@pytest.fixture
def pytest_repo(tmp_path):
    dest = tmp_path / "pytest_repo"
    shutil.copytree(FIXTURE, dest)
    return dest


@pytest.mark.asyncio
async def test_pytest_junit_reports_task_signal_on_failure(pytest_repo):
    broker = ToolBroker(str(pytest_repo))
    outcome = await broker.invoke("pytest-junit", selector="test_sample.py")
    assert outcome.kind is OutcomeKind.TASK_SIGNAL  # a failing suite is a successful invocation
    assert outcome.parsed["total"] == 3
    assert outcome.parsed["cases"]["test_sample::test_passes"] == "PASS"
    assert outcome.parsed["cases"]["test_sample::test_fails"].startswith("FAIL:")
    assert outcome.parsed["cases"]["test_sample::test_skipped"] == "SKIP"


@pytest.mark.asyncio
async def test_pytest_junit_reports_tool_ok_when_all_pass(pytest_repo):
    broker = ToolBroker(str(pytest_repo))
    outcome = await broker.invoke("pytest-junit", selector="test_sample.py::test_passes")
    assert outcome.kind is OutcomeKind.TOOL_OK
    assert outcome.parsed["cases"]["test_sample::test_passes"] == "PASS"
