from __future__ import annotations

import contextlib
import hashlib
import os
import re
from dataclasses import dataclass
from enum import StrEnum
from typing import AsyncIterator, Literal

from deemsvc.sandbox.broker import OutcomeKind, ToolBroker


class Transition(StrEnum):
    REGRESSION = "PASS->FAIL"       # blocks integration, drives retry
    STILL_FAILING = "FAIL->FAIL"    # pre-existing; never charged to the candidate
    FIXED = "FAIL->PASS"
    NEW_FAILING = "NEW->FAIL"       # a test the candidate added that doesn't pass
    NEW_PASSING = "NEW->PASS"
    REMOVED = "REMOVED"             # test deleted by candidate — audit flag


@dataclass(frozen=True)
class TestDelta:
    __test__ = False  # not a pytest test class — name collides with pytest's Test* convention
    test_id: str
    kind: Transition
    trace_head: str = ""


@dataclass(frozen=True)
class VerificationTask:
    step_id: str
    repo_root: str
    baseline_ref: str                       # Intent.baseline_ref (merge-base)
    candidate_ref: str                      # Generator's worktree HEAD
    acceptance_criteria: tuple[str, ...]
    attempt: int                            # 1-based
    max_attempts: int
    prior_signatures: frozenset[str]        # failure signatures from earlier attempts
    changed_paths: tuple[str, ...]


@dataclass
class Verdict:
    decision: Literal["pass", "retry", "escalate"]
    signature: str
    regressions: list[TestDelta] = None  # set in __post_init__ to avoid a mutable default
    new_failing: list[TestDelta] = None
    flaky_quarantined: list[str] = None
    lint: list[dict] = None
    semantic: dict | None = None
    feedback: dict | None = None            # threaded back into task.assign on retry
    reason: str = ""

    def __post_init__(self):
        self.regressions = self.regressions or []
        self.new_failing = self.new_failing or []
        self.flaky_quarantined = self.flaky_quarantined or []
        self.lint = self.lint or []


class VerifierEngine:
    FLAKE_RERUNS = 3
    TOKEN_FLOOR = 30_000        # below this headroom, retrying is throwing good after bad

    def __init__(self, repo_root: str, client=None):
        self.repo_root = repo_root
        self.client = client  # AsyncAnthropic | None — wired in Task 7

    @contextlib.asynccontextmanager
    async def _twin_worktrees(self, task: VerificationTask) -> AsyncIterator[tuple[str, str]]:
        """Two detached worktrees: baseline at merge-base, candidate at the proposed ref.

        Neither shares state with the Generator's worktree; both are destroyed on exit.
        This IS the context boundary — verification consumes git objects, not narrative.
        """
        base = os.path.join(self.repo_root, ".deemsvc", f"wt-base-{task.step_id}")
        cand = os.path.join(self.repo_root, ".deemsvc", f"wt-cand-{task.step_id}")
        git = ToolBroker(self.repo_root)
        for path, ref in ((base, task.baseline_ref), (cand, task.candidate_ref)):
            out = await git.invoke("git", sub="worktree", a1="add",
                                   a2="--detach", a3=path, a4=ref)
            if out.kind is not OutcomeKind.TOOL_OK:
                raise RuntimeError(f"worktree add failed: {out.stderr_tail}")
        try:
            yield base, cand
        finally:
            for path in (base, cand):
                # No trailing "." — `git worktree remove --force <path>` takes exactly
                # one path argument; the blueprint's reference call included a stray
                # extra argument that this plan drops.
                await git.invoke("git", sub="worktree", a1="remove", a2="--force", a3=path)

    async def _snapshot(self, workdir: str, selector: str = "tests") -> dict[str, str]:
        broker = ToolBroker(workdir)
        out = await broker.invoke("pytest-junit", selector=selector)
        if out.kind not in (OutcomeKind.TOOL_OK, OutcomeKind.TASK_SIGNAL):
            raise RuntimeError(f"suite did not run ({out.kind}): {out.stderr_tail}")
        return out.parsed["cases"]          # {test_id: "PASS" | "FAIL:<head>" | "SKIP"}

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

    def _adjudicate(self, task: VerificationTask, budget_headroom: int,
                    regressions: list[TestDelta], new_failing: list[TestDelta],
                    flaky: list[str], lint: list[dict], semantic: dict) -> Verdict:
        unmet = [c["id"] for c in semantic.get("criteria", []) if not c["met"]]
        clean = not regressions and not new_failing and not lint and not unmet
        sig = self._failure_signature(regressions, new_failing, unmet)

        if clean:
            return Verdict("pass", sig, flaky_quarantined=flaky, semantic=semantic,
                           reason="zero regressions, criteria met, diff-scoped lint clean")

        # Hard bounds first: these override any notion of "progress".
        if task.attempt >= task.max_attempts:
            return Verdict("escalate", sig, regressions, new_failing, flaky, lint,
                           semantic, reason=f"attempt ceiling {task.max_attempts} reached")
        if budget_headroom < self.TOKEN_FLOOR:
            return Verdict("escalate", sig, regressions, new_failing, flaky, lint,
                           semantic, reason=f"budget headroom {budget_headroom} < floor")

        # Novelty gate: an identical failure signature means the Generator re-derived
        # the same defect — feedback is not landing. Another retry is deterministic waste.
        if sig in task.prior_signatures:
            return Verdict("escalate", sig, regressions, new_failing, flaky, lint,
                           semantic, reason="repeated failure signature — generator looping")

        # Novel signature -> retry with a feedback packet scoped to exactly what failed.
        feedback = {
            "regressions": [{"test_id": d.test_id, "transition": d.kind,
                             "trace_head": d.trace_head} for d in regressions],
            "new_failing": [{"test_id": d.test_id, "trace_head": d.trace_head}
                            for d in new_failing],
            "diff_scoped_lint": lint,
            "unmet_criteria": unmet,
            "instruction": ("Address ONLY the items above. Do not refactor beyond them. "
                            "Regressed tests define the contract — change the code, "
                            "not the tests, unless a criterion explicitly says otherwise."),
        }
        return Verdict("retry", sig, regressions, new_failing, flaky, lint,
                       semantic, feedback=feedback,
                       reason="novel failure signature — feedback-directed retry")
