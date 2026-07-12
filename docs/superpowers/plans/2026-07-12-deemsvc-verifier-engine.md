# deemsvc Verifier Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the twin-worktree differential Verifier — the component that turns a
Generator's claimed candidate commit into a mechanically-checked `pass | retry |
escalate` verdict, per `docs/AI-CODING-AGENT-ARCHITECTURAL-BLUEPRINT.md` §6.1.

**Architecture:** `VerifierEngine.verify()` creates two detached git worktrees
(baseline at the merge-base, candidate at the proposed ref), runs the pytest suite in
each via the Task-2 `ToolBroker`, diffs the two pass/fail matrices into a list of
`TestDelta` transitions, confirms regressions are deterministic (not flaky) by
rerunning them, scopes lint findings to changed lines only, asks a fresh-context LLM
to judge acceptance criteria against the diff, and adjudicates a verdict using three
independent bounds (attempt ceiling, token floor, failure-signature novelty). Every
piece except the semantic-review LLM call is pure Python or `ToolBroker` calls, so
this plan front-loads pure-function tests before touching git worktrees or the
Anthropic API.

**Tech Stack:** Python 3.11+, `anthropic` (AsyncAnthropic client), `pytest`,
`pytest-asyncio`.

## Global Constraints

- Depends on `deemsvc-tool-broker` (Task 1-4 of that plan: `ToolBroker`, `REGISTRY`,
  the `git` and `pytest-junit` tool specs).
- The semantic-review call uses `model="claude-fable-5"` with a JSON-schema structured
  output (`output_config.format`), per blueprint §6.1 and §8. Tests that hit the real
  API are marked `@pytest.mark.skipif(not os.environ.get("ANTHROPIC_API_KEY"), ...)`
  so the rest of the suite runs offline.
- `FLAKE_RERUNS = 3`, `TOKEN_FLOOR = 30_000` — exact values from the blueprint, not
  tunable in this plan.
- Source reference: `docs/AI-CODING-AGENT-ARCHITECTURAL-BLUEPRINT.md` §6.1
  (`verifier/engine.py`), which this plan adapts near-verbatim for the pure-function
  and worktree pieces; the semantic-review request shape is deferred to the shared
  `build_request` helper built in `deemsvc-fable5-dispatcher` (Task 4 of this plan
  uses a minimal inline request until that helper exists, then Task 4's final step
  notes the follow-up).

---

### Task 1: Transition classification — the pure diff function

**Files:**
- Create: `deemsvc/src/deemsvc/verifier/__init__.py`
- Create: `deemsvc/src/deemsvc/verifier/engine.py`
- Create: `deemsvc/tests/test_verifier_diff_outcomes.py`

**Interfaces:**
- Produces: `Transition` (StrEnum: `REGRESSION="PASS->FAIL"`, `STILL_FAILING="FAIL->FAIL"`, `FIXED="FAIL->PASS"`, `NEW_FAILING="NEW->FAIL"`, `NEW_PASSING="NEW->PASS"`, `REMOVED="REMOVED"`), `TestDelta` (frozen dataclass: `test_id: str, kind: Transition, trace_head: str = ""`), `VerifierEngine._diff_outcomes(before: dict[str,str], after: dict[str,str]) -> list[TestDelta]` (staticmethod, pure — takes two `{test_id: "PASS"|"FAIL:<head>"|"SKIP"}` dicts, the shape `_parse_junit` from `deemsvc-tool-broker` produces).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_verifier_diff_outcomes.py`:

```python
from deemsvc.verifier.engine import Transition, VerifierEngine


def test_pass_to_fail_is_a_regression():
    before = {"t_a": "PASS"}
    after = {"t_a": "FAIL:AssertionError"}
    deltas = VerifierEngine._diff_outcomes(before, after)
    assert deltas == [__import__("deemsvc.verifier.engine", fromlist=["TestDelta"])
                       .TestDelta("t_a", Transition.REGRESSION, "AssertionError")]


def test_fail_to_fail_is_still_failing_not_a_regression():
    before = {"t_a": "FAIL:old error"}
    after = {"t_a": "FAIL:old error"}
    deltas = VerifierEngine._diff_outcomes(before, after)
    assert deltas[0].kind is Transition.STILL_FAILING


def test_fail_to_pass_is_fixed():
    before = {"t_a": "FAIL:old error"}
    after = {"t_a": "PASS"}
    deltas = VerifierEngine._diff_outcomes(before, after)
    assert deltas[0].kind is Transition.FIXED


def test_new_test_that_fails_is_new_failing():
    deltas = VerifierEngine._diff_outcomes({}, {"t_new": "FAIL:not implemented"})
    assert deltas[0].kind is Transition.NEW_FAILING
    assert deltas[0].trace_head == "not implemented"


def test_new_test_that_passes_is_new_passing():
    deltas = VerifierEngine._diff_outcomes({}, {"t_new": "PASS"})
    assert deltas[0].kind is Transition.NEW_PASSING


def test_test_missing_from_candidate_is_removed():
    deltas = VerifierEngine._diff_outcomes({"t_gone": "PASS"}, {})
    assert deltas[0].kind is Transition.REMOVED


def test_skipped_tests_produce_no_delta_when_unchanged():
    before = {"t_a": "SKIP"}
    after = {"t_a": "SKIP"}
    deltas = VerifierEngine._diff_outcomes(before, after)
    assert deltas == []
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_diff_outcomes.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'deemsvc.verifier'`

- [ ] **Step 3: Implement Transition, TestDelta, and _diff_outcomes**

`deemsvc/src/deemsvc/verifier/__init__.py`: empty file.

`deemsvc/src/deemsvc/verifier/engine.py`:

```python
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
    __test__ = False  # not a pytest test class — name collides with pytest's Test* convention
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_diff_outcomes.py -v`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/verifier/__init__.py deemsvc/src/deemsvc/verifier/engine.py \
        deemsvc/tests/test_verifier_diff_outcomes.py
git commit -m "feat(deemsvc): add test-transition classification (_diff_outcomes)"
```

---

### Task 2: Failure signature — the loop detector

**Files:**
- Modify: `deemsvc/src/deemsvc/verifier/engine.py`
- Create: `deemsvc/tests/test_verifier_signature.py`

**Interfaces:**
- Consumes: `TestDelta`, `Transition` from Task 1.
- Produces: `VerifierEngine._failure_signature(regressions: list[TestDelta], new_failing: list[TestDelta], unmet: list[str]) -> str` (staticmethod, 16-char hex).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_verifier_signature.py`:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_signature.py -v`
Expected: FAIL with `AttributeError: type object 'VerifierEngine' has no attribute '_failure_signature'`

- [ ] **Step 3: Implement _failure_signature**

Add to `deemsvc/src/deemsvc/verifier/engine.py` (add `import hashlib` and `import re`
to the imports):

```python
import hashlib
import re
```

Add as a staticmethod on `VerifierEngine`:

```python
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_signature.py -v`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/verifier/engine.py deemsvc/tests/test_verifier_signature.py
git commit -m "feat(deemsvc): add failure-signature loop detector"
```

---

### Task 3: Adjudication — the retry/escalate/pass decision

**Files:**
- Modify: `deemsvc/src/deemsvc/verifier/engine.py`
- Create: `deemsvc/tests/test_verifier_adjudicate.py`

**Interfaces:**
- Consumes: `TestDelta`, `Transition`, `_failure_signature` from Tasks 1-2.
- Produces: `VerificationTask` (frozen dataclass: `step_id, repo_root, baseline_ref, candidate_ref, acceptance_criteria: tuple[str,...], attempt: int, max_attempts: int, prior_signatures: frozenset[str], changed_paths: tuple[str,...]`), `Verdict` (dataclass: `decision: Literal["pass","retry","escalate"], signature, regressions=[], new_failing=[], flaky_quarantined=[], lint=[], semantic=None, feedback=None, reason=""`), `VerifierEngine._adjudicate(self, task, budget_headroom, regressions, new_failing, flaky, lint, semantic) -> Verdict` (instance method — needs `self` only for `self._failure_signature`/`self.TOKEN_FLOOR`, no I/O).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_verifier_adjudicate.py`:

```python
from deemsvc.verifier.engine import Transition, TestDelta, VerificationTask, VerifierEngine


def _task(**overrides) -> VerificationTask:
    defaults = dict(step_id="impl", repo_root="/repo", baseline_ref="base",
                    candidate_ref="cand", acceptance_criteria=("AC-1",),
                    attempt=1, max_attempts=3, prior_signatures=frozenset(),
                    changed_paths=("server/cache.py",))
    defaults.update(overrides)
    return VerificationTask(**defaults)


def test_zero_regressions_and_all_criteria_met_passes():
    engine = VerifierEngine()
    semantic = {"criteria": [{"id": "AC-1", "met": True, "evidence": "diff shows it"}]}
    verdict = engine._adjudicate(_task(), budget_headroom=100_000,
                                 regressions=[], new_failing=[], flaky=[], lint=[],
                                 semantic=semantic)
    assert verdict.decision == "pass"


def test_a_confirmed_regression_never_passes_regardless_of_semantic_judgment():
    engine = VerifierEngine()
    semantic = {"criteria": [{"id": "AC-1", "met": True, "evidence": "looks right"}]}
    regression = [TestDelta("t1", Transition.REGRESSION, "boom")]
    verdict = engine._adjudicate(_task(), budget_headroom=100_000,
                                 regressions=regression, new_failing=[], flaky=[], lint=[],
                                 semantic=semantic)
    assert verdict.decision != "pass"


def test_unmet_criterion_on_a_green_matrix_blocks_pass():
    engine = VerifierEngine()
    semantic = {"criteria": [{"id": "AC-1", "met": False, "evidence": "not found in diff"}]}
    verdict = engine._adjudicate(_task(), budget_headroom=100_000,
                                 regressions=[], new_failing=[], flaky=[], lint=[],
                                 semantic=semantic)
    assert verdict.decision != "pass"


def test_novel_signature_with_budget_and_attempts_retries_with_feedback():
    engine = VerifierEngine()
    semantic = {"criteria": []}
    regression = [TestDelta("t1", Transition.REGRESSION, "boom")]
    verdict = engine._adjudicate(_task(attempt=1, max_attempts=3), budget_headroom=100_000,
                                 regressions=regression, new_failing=[], flaky=[], lint=[],
                                 semantic=semantic)
    assert verdict.decision == "retry"
    assert verdict.feedback is not None
    assert verdict.feedback["regressions"][0]["test_id"] == "t1"


def test_attempt_ceiling_escalates_even_with_budget_headroom():
    engine = VerifierEngine()
    regression = [TestDelta("t1", Transition.REGRESSION, "boom")]
    verdict = engine._adjudicate(_task(attempt=3, max_attempts=3), budget_headroom=100_000,
                                 regressions=regression, new_failing=[], flaky=[], lint=[],
                                 semantic={"criteria": []})
    assert verdict.decision == "escalate"
    assert "attempt ceiling" in verdict.reason


def test_budget_below_floor_escalates_even_on_first_attempt():
    engine = VerifierEngine()
    regression = [TestDelta("t1", Transition.REGRESSION, "boom")]
    verdict = engine._adjudicate(_task(attempt=1, max_attempts=3),
                                 budget_headroom=engine.TOKEN_FLOOR - 1,
                                 regressions=regression, new_failing=[], flaky=[], lint=[],
                                 semantic={"criteria": []})
    assert verdict.decision == "escalate"
    assert "budget headroom" in verdict.reason


def test_repeated_signature_escalates_instead_of_retrying_again():
    engine = VerifierEngine()
    regression = [TestDelta("t1", Transition.REGRESSION, "boom")]
    sig = engine._failure_signature(regression, [], [])
    verdict = engine._adjudicate(_task(attempt=2, max_attempts=5, prior_signatures=frozenset({sig})),
                                 budget_headroom=100_000,
                                 regressions=regression, new_failing=[], flaky=[], lint=[],
                                 semantic={"criteria": []})
    assert verdict.decision == "escalate"
    assert "repeated failure signature" in verdict.reason


def test_flaky_quarantine_and_lint_findings_are_carried_through_the_verdict():
    engine = VerifierEngine()
    verdict = engine._adjudicate(_task(), budget_headroom=100_000,
                                 regressions=[], new_failing=[], flaky=["t_flaky"],
                                 lint=[{"path": "a.py", "line": 1, "code": "F401", "msg": "unused"}],
                                 semantic={"criteria": []})
    assert verdict.decision != "pass"  # lint finding present -> not clean
    assert verdict.flaky_quarantined == ["t_flaky"]
    assert verdict.lint[0]["code"] == "F401"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_adjudicate.py -v`
Expected: FAIL with `ImportError: cannot import name 'VerificationTask'`

- [ ] **Step 3: Implement VerificationTask, Verdict, and _adjudicate**

Add to `deemsvc/src/deemsvc/verifier/engine.py` (add `from typing import Literal` to imports):

```python
from typing import Literal


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
```

Add as a method on `VerifierEngine`:

```python
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_adjudicate.py -v`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/verifier/engine.py deemsvc/tests/test_verifier_adjudicate.py
git commit -m "feat(deemsvc): add Verifier adjudication (pass/retry/escalate)"
```

---

### Task 4: Twin worktrees and snapshot — real git integration

**Files:**
- Modify: `deemsvc/src/deemsvc/verifier/engine.py`
- Create: `deemsvc/tests/fixtures/verifier_repo/build.sh`
- Create: `deemsvc/tests/test_verifier_worktrees.py`

**Interfaces:**
- Consumes: `ToolBroker` from `deemsvc-tool-broker`, `VerificationTask` from Task 3.
- Produces: `VerifierEngine.__init__(self, repo_root: str, client=None)` (client is `AsyncAnthropic | None`, unused until Task 7), `VerifierEngine._twin_worktrees(task) -> AsyncContextManager[tuple[str,str]]`, `VerifierEngine._snapshot(workdir, selector="tests") -> dict[str,str]`.

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/fixtures/verifier_repo/build.sh`:

```bash
#!/usr/bin/env bash
# Builds a throwaway git repo with a baseline commit (2 passing tests) and a
# candidate commit (1 confirmed regression + 1 fix + 1 new passing test), for
# VerifierEngine integration tests. Usage: build.sh <target-dir>; echoes
# "<baseline_sha> <candidate_sha>" on the last line of stdout.
set -euo pipefail
dest="$1"
rm -rf "$dest"
mkdir -p "$dest"
cd "$dest"
git init -q
git config user.email test@example.com
git config user.name Test

mkdir -p tests
cat > tests/test_suite.py <<'EOF'
def test_stable():
    assert 1 == 1

def test_will_regress():
    assert 1 == 1

def test_currently_broken():
    assert 1 == 2
EOF
cat > pytest.ini <<'EOF'
[pytest]
addopts = -p no:cacheprovider
EOF
git add -A
git commit -q -m baseline
baseline=$(git rev-parse HEAD)

cat > tests/test_suite.py <<'EOF'
def test_stable():
    assert 1 == 1

def test_will_regress():
    assert 1 == 2  # regression

def test_currently_broken():
    assert 1 == 1  # fixed

def test_new_and_passing():
    assert True
EOF
git add -A
git commit -q -m candidate
candidate=$(git rev-parse HEAD)

echo "$baseline $candidate"
```

`deemsvc/tests/test_verifier_worktrees.py`:

```python
import subprocess

import pytest

from deemsvc.verifier.engine import VerificationTask, VerifierEngine

FIXTURE = "tests/fixtures/verifier_repo/build.sh"


@pytest.fixture
def repo_with_refs(tmp_path):
    dest = tmp_path / "verifier_repo"
    out = subprocess.run(["bash", FIXTURE, str(dest)], check=True,
                         capture_output=True, text=True)
    baseline, candidate = out.stdout.strip().split()
    return str(dest), baseline, candidate


def _task(repo_root, baseline, candidate, **overrides) -> VerificationTask:
    defaults = dict(step_id="impl", repo_root=repo_root, baseline_ref=baseline,
                    candidate_ref=candidate, acceptance_criteria=(), attempt=1,
                    max_attempts=3, prior_signatures=frozenset(), changed_paths=())
    defaults.update(overrides)
    return VerificationTask(**defaults)


@pytest.mark.asyncio
async def test_twin_worktrees_are_created_and_removed(repo_with_refs):
    repo_root, baseline, candidate = repo_with_refs
    engine = VerifierEngine(repo_root)
    task = _task(repo_root, baseline, candidate)
    async with engine._twin_worktrees(task) as (base_dir, cand_dir):
        assert (__import__("pathlib").Path(base_dir) / "tests" / "test_suite.py").exists()
        assert (__import__("pathlib").Path(cand_dir) / "tests" / "test_suite.py").exists()
        base_src = (__import__("pathlib").Path(base_dir) / "tests" / "test_suite.py").read_text()
        cand_src = (__import__("pathlib").Path(cand_dir) / "tests" / "test_suite.py").read_text()
        assert "test_new_and_passing" not in base_src
        assert "test_new_and_passing" in cand_src
    result = subprocess.run(["git", "worktree", "list"], cwd=repo_root,
                            capture_output=True, text=True)
    assert base_dir not in result.stdout
    assert cand_dir not in result.stdout


@pytest.mark.asyncio
async def test_snapshot_returns_the_expected_case_matrix(repo_with_refs):
    repo_root, baseline, candidate = repo_with_refs
    engine = VerifierEngine(repo_root)
    task = _task(repo_root, baseline, candidate)
    async with engine._twin_worktrees(task) as (base_dir, cand_dir):
        before = await engine._snapshot(base_dir)
        after = await engine._snapshot(cand_dir)
    assert before["::test_will_regress"] == "PASS"
    assert after["::test_will_regress"].startswith("FAIL")
    assert before["::test_currently_broken"].startswith("FAIL")
    assert after["::test_currently_broken"] == "PASS"
    assert "::test_new_and_passing" not in before
    assert after["::test_new_and_passing"] == "PASS"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `chmod +x deemsvc/tests/fixtures/verifier_repo/build.sh && cd deemsvc && .venv/bin/pytest tests/test_verifier_worktrees.py -v`
Expected: FAIL with `TypeError: VerifierEngine.__init__() takes 1 positional argument`

- [ ] **Step 3: Implement __init__, _twin_worktrees, and _snapshot**

Add to `deemsvc/src/deemsvc/verifier/engine.py` (add `import contextlib`, `import os`,
`from typing import AsyncIterator`, and
`from deemsvc.sandbox.broker import OutcomeKind, ToolBroker` to the imports):

```python
import contextlib
import os
from typing import AsyncIterator

from deemsvc.sandbox.broker import OutcomeKind, ToolBroker
```

Add `__init__` and the two methods to `VerifierEngine` (the class currently has only
staticmethods/a method from Task 3 — add `__init__` above `_diff_outcomes`):

```python
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_worktrees.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/verifier/engine.py deemsvc/tests/fixtures/verifier_repo/build.sh \
        deemsvc/tests/test_verifier_worktrees.py
git commit -m "feat(deemsvc): add twin-worktree differential snapshotting"
```

---

### Task 5: Flake bleaching

**Files:**
- Modify: `deemsvc/src/deemsvc/verifier/engine.py`
- Create: `deemsvc/tests/test_verifier_flakes.py`

**Interfaces:**
- Consumes: `ToolBroker`, `TestDelta`, `Transition` from prior tasks.
- Produces: `VerifierEngine._bleach_flakes(self, cand_dir: str, regressions: list[TestDelta]) -> tuple[list[TestDelta], list[str]]` (returns `(confirmed_regressions, flaky_test_ids)`).

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_verifier_flakes.py`:

```python
import shutil

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
    regressions = [TestDelta("::test_flaky", Transition.REGRESSION, "assert n != 0")]
    confirmed, flaky = await engine._bleach_flakes(str(flake_repo), regressions)
    assert confirmed == []
    assert flaky == ["::test_flaky"]


@pytest.mark.asyncio
async def test_deterministic_regression_is_confirmed(flake_repo):
    engine = VerifierEngine(str(flake_repo))
    regressions = [TestDelta("::test_deterministic_failure", Transition.REGRESSION, "assert False")]
    confirmed, flaky = await engine._bleach_flakes(str(flake_repo), regressions)
    assert [d.test_id for d in confirmed] == ["::test_deterministic_failure"]
    assert flaky == []
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_flakes.py -v`
Expected: FAIL with `AttributeError: 'VerifierEngine' object has no attribute '_bleach_flakes'`

- [ ] **Step 3: Implement _bleach_flakes**

Add to `VerifierEngine` in `deemsvc/src/deemsvc/verifier/engine.py`:

```python
    async def _bleach_flakes(self, cand_dir: str,
                             regressions: list[TestDelta]) -> tuple[list[TestDelta], list[str]]:
        """Rerun each regression K times in the candidate tree. Deterministic failure
        stays a regression; any pass among reruns -> quarantine as flaky (logged, not
        charged to the candidate, surfaced in the audit trail)."""
        confirmed, flaky = [], []
        broker = ToolBroker(cand_dir)
        for delta in regressions:
            outcomes = []
            for _ in range(self.FLAKE_RERUNS):
                out = await broker.invoke("pytest-junit", selector=delta.test_id)
                outcomes.append(out.parsed["cases"].get(delta.test_id, "FAIL:missing"))
            if all(o.startswith("FAIL") for o in outcomes):
                confirmed.append(delta)
            else:
                flaky.append(delta.test_id)
        return confirmed, flaky
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_flakes.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/verifier/engine.py deemsvc/tests/test_verifier_flakes.py
git commit -m "feat(deemsvc): add flake bleaching for confirmed-vs-quarantined regressions"
```

---

### Task 6: Diff-scoped lint

**Files:**
- Modify: `deemsvc/src/deemsvc/verifier/engine.py`
- Create: `deemsvc/tests/test_verifier_lint.py`

**Interfaces:**
- Consumes: `ToolBroker`, `VerificationTask` from prior tasks.
- Produces: `VerifierEngine._diff_scoped_lint(self, cand_dir: str, task: VerificationTask) -> list[dict]`.

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_verifier_lint.py`:

```python
import subprocess

import pytest

from deemsvc.verifier.engine import VerificationTask, VerifierEngine


@pytest.fixture
def lint_repo(tmp_path):
    repo = tmp_path / "lint_repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=repo, check=True)
    (repo / "a.py").write_text("import os\n\n\ndef f():\n    return 1\n")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "baseline"], cwd=repo, check=True)
    baseline = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                              capture_output=True, text=True, check=True).stdout.strip()

    # Candidate touches line 5 (adds an unused import there) and leaves the
    # pre-existing unused `os` import on line 1 untouched — that pre-existing
    # finding must NOT appear in diff-scoped results.
    (repo / "a.py").write_text("import os\n\n\ndef f():\n    import sys\n    return 1\n")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "candidate"], cwd=repo, check=True)
    candidate = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                               capture_output=True, text=True, check=True).stdout.strip()
    return str(repo), baseline, candidate


@pytest.mark.asyncio
async def test_lint_findings_are_scoped_to_changed_lines_only(lint_repo):
    repo_root, baseline, candidate = lint_repo
    engine = VerifierEngine(repo_root)
    task = VerificationTask(step_id="s", repo_root=repo_root, baseline_ref=baseline,
                            candidate_ref=candidate, acceptance_criteria=(), attempt=1,
                            max_attempts=3, prior_signatures=frozenset(),
                            changed_paths=("a.py",))
    findings = await engine._diff_scoped_lint(repo_root, task)
    lines = [f["line"] for f in findings]
    assert 5 in lines            # the newly-added unused `import sys`
    assert 1 not in lines        # pre-existing unused `import os` is legacy debt, excluded
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_lint.py -v`
Expected: FAIL with `AttributeError: 'VerifierEngine' object has no attribute '_diff_scoped_lint'`

- [ ] **Step 3: Implement _diff_scoped_lint**

Add to `deemsvc/src/deemsvc/verifier/engine.py` (`re` is already imported from Task 2):

```python
    async def _diff_scoped_lint(self, cand_dir: str,
                                task: VerificationTask) -> list[dict]:
        """Lint findings count only on lines the candidate touched — legacy debt is
        not the Generator's bill. Changed-line map comes from the unified diff."""
        git = ToolBroker(self.repo_root)
        diff = await git.invoke("git", sub="diff", a1="--unified=0",
                                a2=task.baseline_ref, a3=task.candidate_ref)
        changed: dict[str, set[int]] = {}
        current = None
        for line in diff.parsed.get("raw", "").splitlines():
            if line.startswith("+++ b/"):
                current = line[6:]
            elif line.startswith("@@") and current:
                m = re.search(r"\+(\d+)(?:,(\d+))?", line)
                start, count = int(m.group(1)), int(m.group(2) or 1)
                changed.setdefault(current, set()).update(range(start, start + count))
        broker = ToolBroker(cand_dir)
        findings: list[dict] = []
        for path in changed:
            out = await broker.invoke("ruff-json", path=path)
            findings += [f for f in out.parsed["findings"]
                         if f["line"] in changed[f["path"]]]
        return findings
```

Note: unlike the blueprint's version, this drops the unused trailing `a4="."` from
the `git diff` call (the two revs plus an implicit repo-wide scope already produce a
full unified diff; adding `.` as a pathspec is redundant when no `--` separator
precedes it and every path in the repo is in scope anyway).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_lint.py -v`
Expected: 1 passed

- [ ] **Step 5: Commit**

```bash
git add deemsvc/src/deemsvc/verifier/engine.py deemsvc/tests/test_verifier_lint.py
git commit -m "feat(deemsvc): add diff-scoped lint (legacy findings excluded)"
```

---

### Task 7: Semantic review — fresh-context LLM judge

**Files:**
- Modify: `deemsvc/src/deemsvc/verifier/engine.py`
- Create: `deemsvc/tests/test_verifier_semantic_review.py`

**Interfaces:**
- Consumes: `ToolBroker`, `VerificationTask`, `TestDelta` from prior tasks. Requires `pip install anthropic` in `deemsvc`'s dependencies.
- Produces: `VerifierEngine._semantic_review(self, task: VerificationTask, cand_dir: str, deltas: list[TestDelta]) -> dict`.

- [ ] **Step 1: Add the anthropic dependency**

Edit `deemsvc/pyproject.toml`'s `dependencies` list:

```toml
dependencies = ["anthropic>=0.40"]
```

Run: `cd deemsvc && .venv/bin/pip install -e ".[dev]"`
Expected: installs `anthropic` and its transitive deps cleanly.

- [ ] **Step 2: Write the failing test**

`deemsvc/tests/test_verifier_semantic_review.py`:

```python
import os

import pytest

from deemsvc.verifier.engine import Transition, TestDelta, VerificationTask, VerifierEngine

pytestmark = pytest.mark.skipif(
    not os.environ.get("ANTHROPIC_API_KEY"),
    reason="semantic review calls the real Anthropic API",
)


@pytest.fixture
def repo_with_diff(tmp_path):
    import subprocess
    repo = tmp_path / "semantic_repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=repo, check=True)
    (repo / "cache.py").write_text("def get(key):\n    return CACHE.get(key)\n")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "baseline"], cwd=repo, check=True)
    baseline = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                              capture_output=True, text=True, check=True).stdout.strip()
    (repo / "cache.py").write_text(
        "def get(key, schema_version):\n    return CACHE.get((key, schema_version))\n"
    )
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "candidate"], cwd=repo, check=True)
    candidate = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo,
                               capture_output=True, text=True, check=True).stdout.strip()
    return str(repo), baseline, candidate


@pytest.mark.asyncio
async def test_semantic_review_returns_a_schema_shaped_verdict(repo_with_diff):
    from anthropic import AsyncAnthropic

    repo_root, baseline, candidate = repo_with_diff
    engine = VerifierEngine(repo_root, client=AsyncAnthropic())
    task = VerificationTask(
        step_id="s", repo_root=repo_root, baseline_ref=baseline, candidate_ref=candidate,
        acceptance_criteria=("Cache key includes schema_version",), attempt=1,
        max_attempts=3, prior_signatures=frozenset(), changed_paths=("cache.py",),
    )
    result = await engine._semantic_review(task, repo_root, deltas=[])
    assert "criteria" in result
    assert isinstance(result["criteria"], list)
    assert "scope_creep" in result
    assert isinstance(result["scope_creep"], bool)
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY cd deemsvc && .venv/bin/pytest tests/test_verifier_semantic_review.py -v`
Expected (if `ANTHROPIC_API_KEY` is set): FAIL with `AttributeError: 'VerifierEngine'
object has no attribute '_semantic_review'`. If the key is not set, this test is
skipped — that is expected and acceptable; proceed to Step 4 regardless.

- [ ] **Step 4: Implement _semantic_review**

Add to `deemsvc/src/deemsvc/verifier/engine.py` (add `import json` to the imports):

```python
import json
```

Add to `VerifierEngine`:

```python
    async def _semantic_review(self, task: VerificationTask,
                               cand_dir: str, deltas: list[TestDelta]) -> dict:
        """Fresh-context model call. Input = diff + criteria + mechanical evidence.
        The Generator's conversation is structurally unreachable from here."""
        git = ToolBroker(self.repo_root)
        diff = await git.invoke("git", sub="diff", a1=task.baseline_ref, a2=task.candidate_ref)
        response = await self.client.messages.create(
            model="claude-fable-5",
            max_tokens=16000,
            output_config={
                "effort": "high",
                "format": {"type": "json_schema", "schema": {
                    "type": "object",
                    "properties": {
                        "criteria": {"type": "array", "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "met": {"type": "boolean"},
                                "evidence": {"type": "string"},
                            },
                            "required": ["id", "met", "evidence"],
                            "additionalProperties": False,
                        }},
                        "scope_creep": {"type": "boolean"},
                        "notes": {"type": "string"},
                    },
                    "required": ["criteria", "scope_creep", "notes"],
                    "additionalProperties": False,
                }},
            },
            system=("You are a verification judge. You receive a diff and acceptance "
                    "criteria. Judge only what the evidence shows. You cannot see the "
                    "author's reasoning, and you must not infer intent from it. "
                    "Mark a criterion met only if the diff plus test evidence proves it."),
            messages=[{"role": "user", "content": json.dumps({
                "acceptance_criteria": task.acceptance_criteria,
                "diff": diff.parsed.get("raw", "")[:150_000],
                "test_transitions": [
                    {"test_id": d.test_id, "kind": str(d.kind), "trace_head": d.trace_head}
                    for d in deltas
                ],
            })}],
        )
        if response.stop_reason == "refusal":
            return {"criteria": [], "scope_creep": False,
                    "notes": "judge declined; mechanical evidence governs"}
        return json.loads(response.content[-1].text)
```

Note: the fallback-model and server-side-fallback beta wiring from blueprint §6.1 is
intentionally deferred to `deemsvc-fable5-dispatcher`'s shared `build_request` helper
(that plan's Task 1) — this method makes a direct call for now so the Verifier is
testable in isolation; a follow-up in that plan's Task 1 note routes this call through
`build_request` once it exists, adding the fallback chain without changing this
method's signature or return shape.

- [ ] **Step 5: Run the test**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_semantic_review.py -v`
Expected: 1 passed if `ANTHROPIC_API_KEY` is set, 1 skipped otherwise. Either outcome
is acceptable to proceed.

- [ ] **Step 6: Commit**

```bash
git add deemsvc/pyproject.toml deemsvc/src/deemsvc/verifier/engine.py \
        deemsvc/tests/test_verifier_semantic_review.py
git commit -m "feat(deemsvc): add fresh-context semantic review via claude-fable-5"
```

---

### Task 8: End-to-end verify() with the semantic call stubbed

**Files:**
- Modify: `deemsvc/src/deemsvc/verifier/engine.py`
- Create: `deemsvc/tests/test_verifier_end_to_end.py`

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: `VerifierEngine.verify(self, task: VerificationTask, budget_headroom: int) -> Verdict` — wires `_twin_worktrees`, `_snapshot`, `_diff_outcomes`, `_bleach_flakes`, `_diff_scoped_lint`, `_semantic_review`, and `_adjudicate` together.

- [ ] **Step 1: Write the failing test**

`deemsvc/tests/test_verifier_end_to_end.py`:

```python
import subprocess
from unittest.mock import AsyncMock

import pytest

from deemsvc.verifier.engine import VerificationTask, VerifierEngine

FIXTURE = "tests/fixtures/verifier_repo/build.sh"


@pytest.fixture
def repo_with_refs(tmp_path):
    dest = tmp_path / "verifier_repo"
    out = subprocess.run(["bash", FIXTURE, str(dest)], check=True,
                         capture_output=True, text=True)
    baseline, candidate = out.stdout.strip().split()
    return str(dest), baseline, candidate


@pytest.mark.asyncio
async def test_verify_end_to_end_retries_on_a_confirmed_regression(repo_with_refs, monkeypatch):
    repo_root, baseline, candidate = repo_with_refs
    engine = VerifierEngine(repo_root)
    monkeypatch.setattr(
        engine, "_semantic_review",
        AsyncMock(return_value={"criteria": [], "scope_creep": False, "notes": "stubbed"}),
    )
    task = VerificationTask(
        step_id="e2e", repo_root=repo_root, baseline_ref=baseline, candidate_ref=candidate,
        acceptance_criteria=(), attempt=1, max_attempts=3, prior_signatures=frozenset(),
        changed_paths=("tests/test_suite.py",),
    )
    verdict = await engine.verify(task, budget_headroom=100_000)
    assert verdict.decision == "retry"
    assert any(d.test_id == "::test_will_regress" for d in verdict.regressions)
    assert verdict.feedback is not None


@pytest.mark.asyncio
async def test_verify_passes_when_a_second_engine_sees_no_further_regressions(monkeypatch, tmp_path):
    # A repo where baseline == candidate has zero transitions by construction.
    dest = tmp_path / "clean_repo"
    dest.mkdir()
    (dest / "pytest.ini").write_text("[pytest]\naddopts = -p no:cacheprovider\n")
    (dest / "test_clean.py").write_text("def test_ok():\n    assert True\n")
    subprocess.run(["git", "init", "-q"], cwd=dest, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=dest, check=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=dest, check=True)
    subprocess.run(["git", "add", "-A"], cwd=dest, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "only commit"], cwd=dest, check=True)
    sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=dest,
                         capture_output=True, text=True, check=True).stdout.strip()

    engine = VerifierEngine(str(dest))
    from unittest.mock import AsyncMock
    monkeypatch.setattr(
        engine, "_semantic_review",
        AsyncMock(return_value={"criteria": [], "scope_creep": False, "notes": "stubbed"}),
    )
    task = VerificationTask(step_id="clean", repo_root=str(dest), baseline_ref=sha,
                            candidate_ref=sha, acceptance_criteria=(), attempt=1,
                            max_attempts=3, prior_signatures=frozenset(), changed_paths=())
    verdict = await engine.verify(task, budget_headroom=100_000)
    assert verdict.decision == "pass"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_end_to_end.py -v`
Expected: FAIL with `AttributeError: 'VerifierEngine' object has no attribute 'verify'`

- [ ] **Step 3: Implement verify()**

Add to `VerifierEngine`:

```python
    async def verify(self, task: VerificationTask, budget_headroom: int) -> Verdict:
        async with self._twin_worktrees(task) as (base_dir, cand_dir):
            before = await self._snapshot(base_dir)
            after = await self._snapshot(cand_dir)
            deltas = self._diff_outcomes(before, after)

            regressions = [d for d in deltas if d.kind is Transition.REGRESSION]
            regressions, flaky = await self._bleach_flakes(cand_dir, regressions)
            new_failing = [d for d in deltas if d.kind is Transition.NEW_FAILING]

            lint = await self._diff_scoped_lint(cand_dir, task)
            semantic = await self._semantic_review(task, cand_dir, deltas)

            return self._adjudicate(task, budget_headroom,
                                    regressions, new_failing, flaky, lint, semantic)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd deemsvc && .venv/bin/pytest tests/test_verifier_end_to_end.py -v`
Expected: 2 passed

- [ ] **Step 5: Run the full deemsvc test suite**

Run: `cd deemsvc && .venv/bin/pytest -v`
Expected: every test from `deemsvc-orchestrator-core`, `deemsvc-tool-broker`, and this
plan passes together (90+ tests, 0 failures, semantic-review live test skipped unless
`ANTHROPIC_API_KEY` is set).

- [ ] **Step 6: Commit**

```bash
git add deemsvc/src/deemsvc/verifier/engine.py deemsvc/tests/test_verifier_end_to_end.py
git commit -m "feat(deemsvc): wire VerifierEngine.verify() end to end"
```
