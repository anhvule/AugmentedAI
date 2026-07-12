import shutil

import pytest

from deemsvc.sandbox.broker import OutcomeKind, ToolBroker

FIXTURE = "tests/fixtures/ruff_repo"


@pytest.fixture
def ruff_repo(tmp_path):
    dest = tmp_path / "ruff_repo"
    shutil.copytree(FIXTURE, dest)
    return dest


@pytest.mark.asyncio
async def test_ruff_reports_unused_import(ruff_repo):
    broker = ToolBroker(str(ruff_repo))
    outcome = await broker.invoke("ruff-json", path="bad.py")
    assert outcome.kind is OutcomeKind.TOOL_OK  # --exit-zero: findings aren't a nonzero exit
    codes = [f["code"] for f in outcome.parsed["findings"]]
    assert "F401" in codes
    finding = next(f for f in outcome.parsed["findings"] if f["code"] == "F401")
    assert finding["path"] == "bad.py"
    assert finding["line"] == 2  # `import sys`
