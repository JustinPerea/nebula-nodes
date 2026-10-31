"""No cost path prices a key-billing route without the person's keys, and
nothing decides "may cost" but the one cost-class function.

GM, PR #203 r15 item 1: the ghost card priced Idol with no keys and read
"free" while the bar, priced with the token, read "may cost". Whether a
``mayBillWithKey`` route is free or may cost (and who bills a route-table
node) depends on the keys set, so every function that reads it takes them as
a required argument, and this ratchet reads every backend caller and fails on
one that leaves them out or passes an empty mapping in any spelling: ``{}``,
``None``, ``dict()``, or a name bound to one of those.

Review 8 of PR #203, LOW-3 and NIT-1: the class has one source,
node_route.key_billing (with key_billing_account for the account it names).
The gate (may_bill), the billing note (main._space_billing), cost_for and the
estimate read it; a second derivation (reading ``mayBillWithKey`` anywhere
else) fails here.
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path

from services import canvas_proposals, node_route

BACKEND = Path(__file__).resolve().parents[1]
SKIP = {".venv", "tests", "__pycache__", "node_modules"}

# Each function that prices or classes a node with the person's keys, and
# where its keys go: (positional index, keyword).
KEYED = {
    "cost_for": (3, "api_keys"),
    "live_cost": (2, "api_keys"),
    "key_billing": (2, "api_keys"),
    "may_bill": (2, "api_keys"),
    "key_billing_account": (2, "api_keys"),
}
# Read only in node_route: the class (key_billing) and the route checks.
FLAG = "mayBillWithKey"
FLAG_READERS = {("services/node_route.py", "key_billing"), ("services/node_route.py", "routes_problems"),
                ("services/node_route.py", "_ROUTE_FIELDS")}


def _sources() -> list[Path]:
    return [path for path in BACKEND.rglob("*.py") if not SKIP & set(path.relative_to(BACKEND).parts)]


_PARSED: dict[str, list[tuple[Path, ast.Module]]] = {}


def _trees() -> list[tuple[Path, ast.Module]]:
    """Every backend source, parsed once per root (the backend is large)."""
    root = str(BACKEND)
    if root not in _PARSED:
        _PARSED[root] = [(path, ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
                         for path in _sources()]
    return _PARSED[root]


def _called(call: ast.Call) -> str | None:
    func = call.func
    return func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None


def _calls(name: str) -> list[tuple[Path, ast.Call, set[str]]]:
    found = []
    for path, tree in _trees():
        empty = _empty_names(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and _called(node) == name:
                found.append((path, node, empty))
    return found


def _empty_names(tree: ast.Module) -> set[str]:
    """Names this file ever binds to an empty mapping or None."""
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None and _empty(node.value, set()):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names.update(target.id for target in targets if isinstance(target, ast.Name))
    return names


def _empty(value: ast.AST, names: set[str]) -> bool:
    """A keyless price in disguise: None, {}, dict(), or a name bound to one."""
    if isinstance(value, ast.Constant):
        return True
    if isinstance(value, ast.Dict):
        return not value.keys
    if isinstance(value, ast.Call) and _called(value) == "dict":
        return not value.args and not value.keywords
    return isinstance(value, ast.Name) and value.id in names


def _where(path: Path, node: ast.AST) -> str:
    return f"{path.relative_to(BACKEND)}:{getattr(node, 'lineno', 0)}"


def _keys_of(call: ast.Call, index: int, keyword: str) -> ast.AST | None:
    """The argument a call passes as the keys, or None when it passes none."""
    if any(isinstance(arg, ast.Starred) for arg in call.args):
        return ast.Name(id="*", ctx=ast.Load())
    for item in call.keywords:
        if item.arg == keyword:
            return item.value
    return call.args[index] if len(call.args) > index else None


def test_cost_for_requires_the_keys():
    parameter = inspect.signature(canvas_proposals.cost_for).parameters["api_keys"]
    assert parameter.default is inspect.Parameter.empty


def test_view_requires_the_keys():
    parameter = inspect.signature(canvas_proposals.ProposalBook.view).parameters["api_keys"]
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    assert parameter.default is inspect.Parameter.empty


def test_every_class_function_requires_the_keys():
    for name in ("key_billing", "may_bill", "key_billing_account"):
        assert inspect.signature(getattr(node_route, name)).parameters["api_keys"].default is inspect.Parameter.empty
    assert inspect.signature(canvas_proposals.live_cost).parameters["api_keys"].default is inspect.Parameter.empty


def test_every_keyed_call_passes_the_keys():
    assert len(_calls("cost_for")) >= 3, "the scan found too few cost_for calls; is it reading the backend?"
    bad = []
    for name, (index, keyword) in KEYED.items():
        for path, call, empty in _calls(name):
            keys = _keys_of(call, index, keyword)
            if keys is None or _empty(keys, empty):
                bad.append(f"{name} at {_where(path, call)}")
    assert not bad, f"priced or classed without the person's keys: {bad}"


def test_every_proposal_view_call_passes_the_keys():
    calls = [(path, call, empty) for path, call, empty in _calls("view")
             if any(keyword.arg == "registry" for keyword in call.keywords)]
    assert calls, "the scan found no canvas_proposals.view call; is it reading the backend?"
    bad = [_where(path, call) for path, call, empty in calls
           if not any(keyword.arg == "api_keys" and not _empty(keyword.value, empty) for keyword in call.keywords)]
    assert not bad, f"canvas_proposals.view called without the person's keys at {bad}"


def _flag_reads() -> list[str]:
    """Each place that reads ``mayBillWithKey`` as code (not a docstring),
    as "file:line in <scope>"."""
    found = []
    for path, tree in _trees():
        where = str(path.relative_to(BACKEND))
        docstrings = {id(node.value) for node in ast.walk(tree)
                      if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)}

        def visit(node: ast.AST, scope: str) -> None:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                scope = node.name
            elif isinstance(node, ast.Assign) and scope == "<module>":
                names = [target.id for target in node.targets if isinstance(target, ast.Name)]
                if names:
                    for child in ast.iter_child_nodes(node):
                        visit(child, names[0])
                    return
            if (isinstance(node, ast.Constant) and node.value == FLAG and id(node) not in docstrings
                    and (where, scope) not in FLAG_READERS):
                found.append(f"{where}:{node.lineno} in {scope}")
            for child in ast.iter_child_nodes(node):
                visit(child, scope)

        visit(tree, "<module>")
    return found


def test_only_the_one_cost_class_function_reads_the_route_flag():
    """Review 8 of PR #203, LOW-3: "may cost" has one source. A surface that
    reads ``mayBillWithKey`` itself (the gate, the billing note, a label) is
    a second derivation that can drift on the next keyed route."""
    assert not _flag_reads(), f"read {FLAG} outside node_route.key_billing: {_flag_reads()}"


def test_the_ratchet_catches_each_disguise(tmp_path, monkeypatch):
    """The scan itself: each planted form is reported (review 8, NIT-1)."""
    planted = {
        "keyless.py": "cost_for(d, p, defs)\n",
        "literal.py": "cost_for(d, p, defs, {})\n",
        "none.py": "cost_for(d, p, defs, None)\n",
        "dict_call.py": "cost_for(d, p, defs, api_keys=dict())\n",
        "named.py": "NO_KEYS = {}\ncost_for(d, p, defs, NO_KEYS)\n",
        "listing.py": "live_cost(proposal, defs, {})\n",
        "confirm.py": "key_billing(definition, params, {})\n",
        "gate.py": "may_bill(definition, params, dict())\n",
        "account.py": "key_billing_account(definition, params)\n",
        "view.py": "book.view(p, registry=r)\nbook.view(p, registry=r, api_keys=dict())\n",
        "second.py": "def note(route):\n    return route.get('mayBillWithKey')\n",
    }
    for name, source in planted.items():
        (tmp_path / name).write_text(source, encoding="utf-8")
    (tmp_path / "fine.py").write_text("cost_for(d, p, defs, keys)\nbook.view(p, registry=r, api_keys=keys)\n"
                                      "def f():\n    \"\"\"mayBillWithKey in a docstring.\"\"\"\n",
                                      encoding="utf-8")
    monkeypatch.setitem(globals(), "BACKEND", tmp_path)
    reported = []
    for test in (test_every_keyed_call_passes_the_keys, test_every_proposal_view_call_passes_the_keys,
                 test_only_the_one_cost_class_function_reads_the_route_flag):
        try:
            test()
        except AssertionError as error:
            reported.append(str(error))
    text = " ".join(reported)
    for name in planted:
        assert name in text, f"{name} not caught: {text}"
    assert "fine.py" not in text
