from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class Transition(StrEnum):
    REGRESSION = "PASS->FAIL"       # blocks integration, drives retry
    STILL_FAILING = "FAIL->FAIL"    # pre-existing; never charged to the candidate
    FIXED = "FAIL->PASS"
    NEW_FAILING = "NEW->FAIL"       # a test the candidate added that doesn't pass
    NEW_PASSING = "NEW->PASS"
    REMOVED = "REMOVED"             # test deleted by candidate — audit flag


@dataclass(frozen=True)
class TestDelta:
    test_id: str
    kind: Transition
    trace_head: str = ""


class VerifierEngine:
    FLAKE_RERUNS = 3
    TOKEN_FLOOR = 30_000        # below this headroom, retrying is throwing good after bad

    @staticmethod
    def _diff_outcomes(before: dict[str, str], after: dict[str, str]) -> list[TestDelta]:
        deltas: list[TestDelta] = []
        for tid, res in after.items():
            prev = before.get(tid)
            failed, head = res.startswith("FAIL"), res.partition(":")[2]
            if prev is None:
                deltas.append(TestDelta(tid, Transition.NEW_FAILING if failed
                                        else Transition.NEW_PASSING, head))
            elif prev == "PASS" and failed:
                deltas.append(TestDelta(tid, Transition.REGRESSION, head))
            elif prev.startswith("FAIL") and failed:
                deltas.append(TestDelta(tid, Transition.STILL_FAILING, head))
            elif prev.startswith("FAIL") and res == "PASS":
                deltas.append(TestDelta(tid, Transition.FIXED))
        deltas.extend(TestDelta(tid, Transition.REMOVED)
                      for tid in before.keys() - after.keys())
        return deltas
