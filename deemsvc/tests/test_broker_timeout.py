import time

import pytest

from deemsvc.sandbox.broker import OutcomeKind, ToolBroker
from deemsvc.sandbox import testing_tools  # noqa: F401 — registers REGISTRY["sleep"]


@pytest.mark.asyncio
async def test_slow_tool_is_killed_within_its_timeout(tmp_path):
    broker = ToolBroker(str(tmp_path))
    start = time.monotonic()
    outcome = await broker.invoke("sleep", seconds="5")  # spec timeout is 1s — see Step 3
    elapsed = time.monotonic() - start
    assert outcome.kind is OutcomeKind.TIMEOUT
    assert elapsed < 3  # killed well before the child's own 5s sleep would finish


@pytest.mark.asyncio
async def test_fast_tool_under_timeout_succeeds(tmp_path):
    broker = ToolBroker(str(tmp_path))
    outcome = await broker.invoke("sleep", seconds="0")
    assert outcome.kind is OutcomeKind.TOOL_OK
