from __future__ import annotations

import hashlib
import re
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

    @staticmethod
    def _failure_signature(regressions: list[TestDelta], new_failing: list[TestDelta],
                           unmet: list[str]) -> str:
        """Stable hash of the failure *shape*. Trace heads are normalized (addresses,
        line numbers, temp paths stripped) so cosmetically different reruns of the
        same defect collide — that collision is the loop detector."""
        norm = lambda s: re.sub(r"0x[0-9a-f]+|:\d+|/tmp/\S+", "·", s.lower())
        basis = sorted(
            [f"{d.test_id}|{d.kind}|{norm(d.trace_head)}"
             for d in (*regressions, *new_failing)]
            + [f"unmet|{c}" for c in sorted(unmet)]
        )
        return hashlib.sha256("\n".join(basis).encode()).hexdigest()[:16]
