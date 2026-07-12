import pytest

from deemsvc.orchestrator.state import BudgetExhausted, TokenBudget


def test_reserve_then_commit_moves_reservation_to_committed():
    budget = TokenBudget(ceiling=1000)
    budget.reserve("s1", "generate", fallback=200)
    assert budget.headroom() == 800
    budget.commit("s1", "generate", actual=180)
    assert budget.headroom() == 820
    assert budget.pressure() == pytest.approx(0.18)


def test_reserve_exceeding_headroom_raises_budget_exhausted():
    budget = TokenBudget(ceiling=100)
    budget.reserve("s1", "generate", fallback=90)
    with pytest.raises(BudgetExhausted) as exc:
        budget.reserve("s2", "generate", fallback=50)
    assert exc.value.needed == 50
    assert exc.value.headroom == 10


def test_release_frees_reservation_without_committing():
    budget = TokenBudget(ceiling=100)
    budget.reserve("s1", "generate", fallback=90)
    budget.release("s1")
    assert budget.headroom() == 100
    assert budget.pressure() == 0


def test_commit_updates_ewma_for_future_projections():
    budget = TokenBudget(ceiling=10_000)
    budget.reserve("s1", "generate", fallback=1000)
    budget.commit("s1", "generate", actual=2000)
    # EWMA_ALPHA=0.30: 0.30*2000 + 0.70*1000 = 1300
    assert budget.projected_cost("generate", fallback=1000) == 1300


def test_concurrent_reservations_never_exceed_ceiling():
    budget = TokenBudget(ceiling=1000)
    reserved = []
    for i in range(5):
        try:
            reserved.append(budget.reserve(f"s{i}", "generate", fallback=250))
        except BudgetExhausted:
            pass
    # At most 4 reservations of 250 fit in a ceiling of 1000.
    assert sum(reserved) <= 1000
    assert len(reserved) == 4
