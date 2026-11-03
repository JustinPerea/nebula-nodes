"""Stand-ins for live methods take the keywords the real method takes
(#222 round 3, item 5).

A test that swaps a method of the live graph, the connection manager or
agent_presence for a local function with ``monkeypatch.setattr`` broke twice
when the real method gained a keyword: ``broadcast_raw(..., others=)`` and
``CLIGraph.update_params(..., drop=)`` (the fence test in
test_provider_start_admission.py, fixed in 0b5ac02e). The route under test
then fails with a TypeError inside the stand-in, far from the change.

This scans every test module for ``monkeypatch.setattr(<obj>, "<method>",
fn)`` where ``<obj>`` is ``cli_graph``, ``manager`` or ``agent_presence``
(through any module prefix, or the classes ``CLIGraph`` and
``ConnectionManager``) and ``fn`` is a function or lambda defined in the same
module. ``fn`` must accept ``**kwargs``, or take every parameter the real
method takes now (``inspect.signature``). Opt out on the setattr line or the
line above with ``# stand-in-ok: <reason>``; the reason is required.
"""
from __future__ import annotations

import ast
import inspect
import re
from pathlib import Path
from typing import Any, Callable

TESTS = Path(__file__).resolve().parent
OPT_OUT = re.compile(r"#\s*stand-in-ok:\s*(\S.*)?$")
CLI_GRAPH_NAMES = {"cli_graph", "CLIGraph"}
MANAGER_NAMES = {"manager", "ConnectionManager"}
PRESENCE_NAMES = {"agent_presence"}
CLASS_NAMES = {"CLIGraph", "ConnectionManager"}


def _owner_name(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _real(owner: str, method: str) -> Callable[..., Any] | None:
    if owner in CLI_GRAPH_NAMES:
        from services.cli_graph import CLIGraph
        return getattr(CLIGraph, method, None)
    if owner in MANAGER_NAMES:
        import main
        return getattr(main.ConnectionManager, method, None)
    if owner in PRESENCE_NAMES:
        from services import agent_presence
        return getattr(agent_presence, method, None)
    return None


def _missing(fn: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda, real: Callable[..., Any],
             bound: bool) -> list[str]:
    """What of the real method's current signature the stand-in can't take.
    Required parameters come by position, so they only need the room; one
    with a default or keyword-only (how a new keyword arrives) needs its
    name. ``bound``: patched on an instance or a module, so no ``self``."""
    args = fn.args
    if args.kwarg is not None:
        return []
    names = {a.arg for a in [*args.posonlyargs, *args.args, *args.kwonlyargs]}
    positional = len(args.posonlyargs) + len(args.args)
    try:
        signature = inspect.signature(real)
    except (TypeError, ValueError):
        return []
    params = list(signature.parameters.values())
    if bound and params and params[0].name in ("self", "cls") and inspect.isfunction(real):
        params = params[1:]
    missing: list[str] = []
    required = [p for p in params if p.kind in (inspect.Parameter.POSITIONAL_ONLY,
                                                inspect.Parameter.POSITIONAL_OR_KEYWORD)
                and p.default is inspect.Parameter.empty]
    if len(required) > positional and args.vararg is None:
        missing.extend(p.name for p in required[positional:])
    for param in params:
        if param.kind is inspect.Parameter.VAR_POSITIONAL:
            if args.vararg is None:
                missing.append(f"*{param.name}")
        elif param.kind is inspect.Parameter.VAR_KEYWORD:
            missing.append(f"**{param.name}")
        elif param.default is not inspect.Parameter.empty or param.kind is inspect.Parameter.KEYWORD_ONLY:
            if param.name not in names:
                missing.append(param.name)
    return missing


def _definitions(tree: ast.AST) -> dict[str, list[ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda]]:
    """Every function (and lambda bound to a name) in the module, by name."""
    found: dict[str, list[Any]] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            found.setdefault(node.name, []).append(node)
        elif isinstance(node, ast.Assign) and isinstance(node.value, ast.Lambda):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    found.setdefault(target.id, []).append(node.value)
    return found


def find_stand_in_faults(sources: dict[str, str], checked: list[str] | None = None) -> list[str]:
    """Each stand-in, by "file:line method", that can't take what the real
    method takes now. ``sources`` maps a display path to module source."""
    faults: list[str] = []
    for path, source in sorted(sources.items()):
        tree = ast.parse(source)
        lines = source.splitlines()
        definitions = _definitions(tree)
        for call in ast.walk(tree):
            if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                    and call.func.attr == "setattr" and _owner_name(call.func.value) == "monkeypatch"
                    and len(call.args) >= 3):
                continue
            owner = _owner_name(call.args[0])
            method = call.args[1]
            if owner is None or not isinstance(method, ast.Constant) or not isinstance(method.value, str):
                continue
            stand_in = call.args[2]
            candidates: list[Any]
            if isinstance(stand_in, ast.Lambda):
                candidates = [stand_in]
            elif isinstance(stand_in, ast.Name):
                candidates = definitions.get(stand_in.id, [])
            else:
                continue  # a Mock, a partial, another object's method: not a local function
            if not candidates:
                continue
            real = _real(owner, method.value)
            if real is None or not callable(real):
                continue
            here = [lines[call.lineno - 1], lines[call.lineno - 2] if call.lineno >= 2 else ""]
            opt_outs = [OPT_OUT.search(line) for line in here]
            if any(opt_outs):
                if not any(m and m.group(1) and m.group(1).strip() for m in opt_outs):
                    faults.append(f"{path}:{call.lineno} {method.value}: stand-in-ok needs a reason")
                continue
            if checked is not None:
                checked.append(f"{path}:{call.lineno} {method.value}")
            # The nearest definition above the call (names repeat across tests).
            before = [c for c in candidates if c.lineno <= call.lineno] or candidates
            fn = max(before, key=lambda c: c.lineno)
            missing = _missing(fn, real, bound=owner not in CLASS_NAMES)
            if missing:
                faults.append(f"{path}:{call.lineno} {method.value}: stand-in lacks {', '.join(missing)} "
                              f"(take **kwargs, or the real signature {inspect.signature(real)})")
    return faults


def _test_sources() -> dict[str, str]:
    return {str(p.relative_to(TESTS.parent)): p.read_text(encoding="utf-8") for p in sorted(TESTS.rglob("*.py"))}


def test_every_stand_in_takes_what_the_real_method_takes():
    checked: list[str] = []
    faults = find_stand_in_faults(_test_sources(), checked)
    # The scan reads real stand-ins (the fence test's update_params among them).
    assert len(checked) >= 20, checked
    assert any(entry.startswith("tests/test_provider_start_admission.py:") and entry.endswith(" update_params")
               for entry in checked), checked
    assert not faults, "Stand-ins that would break on the real method's keywords:\n" + "\n".join(faults)


def test_the_scan_catches_a_stand_in_without_the_new_keyword():
    """The update_params stand-in as it was before 0b5ac02e fails; with
    **kwargs, with the real signature or with a reasoned opt-out it passes."""
    old = '''
def test_x(monkeypatch):
    def commit(target_id, params):
        pass
    monkeypatch.setattr(main_module.cli_graph, "update_params", commit)
'''
    assert find_stand_in_faults({"t.py": old}) == [
        "t.py:5 update_params: stand-in lacks drop (take **kwargs, or the real signature "
        "(self, node_id: 'str', params: 'dict[str, Any]', drop: 'Iterable[str]' = ()) -> 'None')"]
    assert find_stand_in_faults({"t.py": old.replace("params):", "params, **kwargs):")}) == []
    assert find_stand_in_faults({"t.py": old.replace("params):", "params, drop=()):")}) == []
    assert find_stand_in_faults({"t.py": old.replace("    monkeypatch", "    # stand-in-ok: positional only here\n"
                                                                   "    monkeypatch")}) == []
    reasonless = find_stand_in_faults({"t.py": old.replace("commit)", "commit)  # stand-in-ok:")})
    assert reasonless == ["t.py:5 update_params: stand-in-ok needs a reason"]


def test_the_scan_reads_broadcast_raw_lambdas_and_agent_presence():
    src = '''
async def test_y(monkeypatch):
    monkeypatch.setattr(main.manager, "broadcast_raw", lambda message: None)
    monkeypatch.setattr(main.manager, "broadcast_raw", lambda *a, **k: None)
'''
    faults = find_stand_in_faults({"t.py": src})
    assert len(faults) == 1 and faults[0].startswith("t.py:3 broadcast_raw: stand-in lacks ")


def test_a_class_patch_counts_self():
    src = '''
def test_z(monkeypatch):
    def failed_connect(candidate, *args):
        pass
    def short(candidate, a, b, c):
        pass
    monkeypatch.setattr(CLIGraph, "connect", failed_connect)
    monkeypatch.setattr(CLIGraph, "connect", short)
'''
    faults = find_stand_in_faults({"t.py": src})
    assert faults == [faults[0]] and faults[0].startswith("t.py:8 connect: stand-in lacks dst_port")
