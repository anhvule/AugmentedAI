"""Tool specs used only by deemsvc's own test suite — never exposed to an agent
role or the Verifier. Registered into the shared REGISTRY at import time so tests
can exercise ToolBroker.invoke's timeout and confinement paths without a real
long-running tool."""
from __future__ import annotations

from .broker import REGISTRY, ToolSpec, _parse_raw


REGISTRY["sleep"] = ToolSpec(
    name="sleep",
    argv=("python3", "-c", "import sys, time; time.sleep(float(sys.argv[1]))", "{seconds}"),
    timeout_s=1,
    ok_exits=frozenset({0}),
    signal_exits=frozenset(),
    parser=_parse_raw,
)
