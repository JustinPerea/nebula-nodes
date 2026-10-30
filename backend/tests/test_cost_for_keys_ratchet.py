"""No cost path prices a key-billing route without the person's keys.

GM, PR #203 r15 item 1: the ghost card priced Idol with no keys and read
"free" while the bar, priced with the token, read "may cost". Whether a
``mayBillWithKey`` route is free or may cost (and who bills a route-table
node) depends on the keys set, so canvas_proposals.cost_for takes them as a
required argument and canvas_proposals.view takes them as a required keyword.
This ratchet reads every backend caller and fails on one that leaves them out.
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path

from services import canvas_proposals

BACKEND = Path(__file__).resolve().parents[1]
SKIP = {".venv", "tests", "__pycache__", "node_modules"}


def _sources() -> list[Path]:
    return [path for path in BACKEND.rglob("*.py") if not SKIP & set(path.relative_to(BACKEND).parts)]


def _calls(name: str) -> list[tuple[Path, ast.Call]]:
    found: list[tuple[Path, ast.Call]] = []
    for path in _sources():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            called = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
            if called == name:
                found.append((path, node))
    return found


def _where(path: Path, call: ast.Call) -> str:
    return f"{path.relative_to(BACKEND)}:{call.lineno}"


def test_cost_for_requires_the_keys():
    parameter = inspect.signature(canvas_proposals.cost_for).parameters["api_keys"]
    assert parameter.default is inspect.Parameter.empty


def test_view_requires_the_keys():
    parameter = inspect.signature(canvas_proposals.ProposalBook.view).parameters["api_keys"]
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    assert parameter.default is inspect.Parameter.empty


def test_every_cost_for_call_passes_the_keys():
    calls = _calls("cost_for")
    assert len(calls) >= 3, "the scan found too few cost_for calls; is it reading the backend?"
    bad = [_where(path, call) for path, call in calls
           if len(call.args) < 4 and not any(keyword.arg == "api_keys" for keyword in call.keywords)
           and not any(isinstance(arg, ast.Starred) for arg in call.args)]
    assert not bad, f"cost_for called without api_keys at {bad}"
    # A None or empty literal for the keys is a keyless price in disguise.
    literal = [_where(path, call) for path, call in calls
               if (call.args[3:4] and isinstance(call.args[3], (ast.Constant, ast.Dict)))
               or any(keyword.arg == "api_keys" and isinstance(keyword.value, (ast.Constant, ast.Dict))
                      for keyword in call.keywords)]
    assert not literal, f"cost_for called with literal keys at {literal}"


def test_every_proposal_view_call_passes_the_keys():
    calls = [(path, call) for path, call in _calls("view")
             if any(keyword.arg == "registry" for keyword in call.keywords)]
    assert calls, "the scan found no canvas_proposals.view call; is it reading the backend?"
    bad = [_where(path, call) for path, call in calls
           if not any(keyword.arg == "api_keys" and not isinstance(keyword.value, (ast.Constant, ast.Dict))
                      for keyword in call.keywords)]
    assert not bad, f"canvas_proposals.view called without the person's keys at {bad}"


def test_the_ratchet_catches_a_keyless_call(tmp_path, monkeypatch):
    """The scan itself: each planted keyless call is reported."""
    (tmp_path / "planted.py").write_text(
        "cost_for(d, p, defs, keys)\ncost_for(d, p, defs)\ncost_for(d, p, defs, {})\n"
        "book.view(p, registry=r)\n", encoding="utf-8")
    monkeypatch.setitem(globals(), "BACKEND", tmp_path)
    for test in (test_every_cost_for_call_passes_the_keys, test_every_proposal_view_call_passes_the_keys):
        try:
            test()
        except AssertionError as error:
            assert "planted.py" in str(error), error
        else:
            raise AssertionError(f"{test.__name__} passed on a keyless call")
