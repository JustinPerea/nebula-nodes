"""What the agent-surface guard reads off the running code, and the dev helper.

``agent_surface.py`` is the manifest (one row per route, CLI command, event,
``_`` param and canvas store action). This module finds what exists today and
holds every check ``tests/test_agent_surface.py`` runs, so the person merging
the next PR can see in one go what is unmapped or stale, each with the row to
add:

    cd backend && .venv/bin/python agent_surface_check.py          # what's unmapped or stale
    cd backend && .venv/bin/python agent_surface_check.py --write  # refresh data/agent_surface.json
    node frontend/scripts/check-agent-surface.mjs                  # the canvas side

``--write`` refreshes the JSON export ``frontend/scripts/check-agent-surface.mjs``
reads (canvas /api calls, graphStore actions, "_" params). Importing ``main``
seeds ~/.nebula and reads settings, so the helper first points HOME, the
settings path and every store root at a temp folder it deletes on exit
(``isolate_state``); it never sees or touches the person's state.
"""
from __future__ import annotations

import argparse
import ast
import functools
import inspect
import json
import re
import sys
import textwrap
from pathlib import Path
from typing import Any, Iterable

BACKEND = Path(__file__).resolve().parent
REPO = BACKEND.parent
EXPORT_PATH = BACKEND / "data" / "agent_surface.json"
MCP_DOC = REPO / "docs" / "MCP-SETUP.md"

if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import agent_surface as surface  # noqa: E402

# Where the backend reads node params and where its broadcasts are built.
PARAM_SCAN_DIRS = ("handlers", "execution", "services")
BROADCAST_FILES = ("main.py", "routes", "services")
BROADCAST_METHODS = frozenset({"broadcast_raw", "broadcast_others", "broadcast_browser"})
# The socket the canvas, CLI and MCP listen on (the manager's broadcasts go here).
# Its handler's own sends are read too; /ws/chat is the in-app chat's channel.
CANVAS_SOCKET = "/ws"
# Gate helpers. A route is gated when a dependency in its tree is one of
# GATE_DEPENDENCIES, or when its handler (or a helper it calls first thing)
# calls GATE_CALL unconditionally.
GATE_CALL = "require_person"
GATE_DEPENDENCIES = frozenset({"person_only", "human_dep"})


# -- routes ---------------------------------------------------------------------

def app_routes(app: Any) -> dict[str, Any]:
    """{"METHOD /path": route} for every HTTP route and websocket the app serves,
    mounted routers included. HEAD is FastAPI's shadow of GET and is left out;
    the OpenAPI/docs pages are Exempt by rule (see ``is_framework_route``)."""
    from fastapi.routing import APIRoute, APIWebSocketRoute
    from starlette.routing import WebSocketRoute

    found: dict[str, Any] = {}
    for route in app.routes:
        if isinstance(route, APIRoute):
            for method in sorted(route.methods - {"HEAD"}):
                found[f"{method} {route.path}"] = route
        elif isinstance(route, (APIWebSocketRoute, WebSocketRoute)):
            found[f"WS {route.path}"] = route
    return found


def unreadable_routes(app: Any) -> list[tuple[str, str]]:
    """[(path, kind)] for whatever the app serves that app_routes can't key: a
    mounted sub-app or static folder, a bare Starlette route. FastAPI's own
    pages (/docs, /redoc, /openapi.json) are not features and are left out."""
    from fastapi.routing import APIRoute, APIWebSocketRoute
    from starlette.routing import WebSocketRoute

    framework = {getattr(app, name, None) for name in
                 ("openapi_url", "docs_url", "redoc_url", "swagger_ui_oauth2_redirect_url")} - {None}
    return sorted((getattr(r, "path", "?"), type(r).__name__) for r in app.routes
                  if not isinstance(r, (APIRoute, APIWebSocketRoute, WebSocketRoute))
                  and getattr(r, "path", None) not in framework)


def _dependency_names(dependant: Any) -> set[str]:
    names: set[str] = set()
    for dep in getattr(dependant, "dependencies", []) or []:
        call = getattr(dep, "call", None)
        if call is not None:
            names.add(getattr(call, "__name__", ""))
        names |= _dependency_names(dep)
    return names


def _function_ast(fn: Any) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    try:
        source = textwrap.dedent(inspect.getsource(inspect.unwrap(fn)))
    except (OSError, TypeError):
        return None
    tree = ast.parse(source)
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return node
    return None


def _top_statements(body: list[ast.stmt]) -> Iterable[ast.stmt]:
    """Statements that always run: the body, and the body of a top-level try."""
    for stmt in body:
        if isinstance(stmt, ast.Try):
            yield from _top_statements(stmt.body)
        elif isinstance(stmt, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.With, ast.AsyncWith, ast.Match)):
            # A with block always runs its body; the others may not.
            if isinstance(stmt, (ast.With, ast.AsyncWith)):
                yield from _top_statements(stmt.body)
        else:
            yield stmt


def _called_names(stmt: ast.stmt) -> list[str]:
    names = []
    for node in ast.walk(stmt):
        if isinstance(node, (ast.Lambda, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name):
                names.append(func.id)
            elif isinstance(func, ast.Attribute):
                names.append(func.attr)
    return names


def handler_gate(fn: Any, depth: int = 3) -> bool:
    """True when the function calls require_person on every path before it can
    return, directly or through a helper in its own module that does."""
    tree = _function_ast(fn)
    if tree is None:
        return False
    module = sys.modules.get(getattr(inspect.unwrap(fn), "__module__", ""), None)
    for stmt in _top_statements(tree.body):
        for name in _called_names(stmt):
            if name == GATE_CALL:
                return True
            if depth and module is not None and name.startswith("_"):
                helper = getattr(module, name, None)
                if callable(helper) and inspect.isfunction(inspect.unwrap(helper)) and handler_gate(helper, depth - 1):
                    return True
        if isinstance(stmt, ast.Return):
            break
    return False


def route_gate(route: Any) -> str | None:
    """"dependency" or "handler" when an agent can't get through, else None."""
    if _dependency_names(getattr(route, "dependant", None)) & GATE_DEPENDENCIES:
        return "dependency"
    if handler_gate(route.endpoint):
        return "handler"
    return None


def route_regex(path: str) -> re.Pattern[str]:
    out = ""
    for part in re.split(r"(\{[^}]+\})", path):
        if part.startswith("{"):
            out += ".+" if part.endswith(":path}") else "[^/]+"
        else:
            out += re.escape(part)
    return re.compile(out)


# -- MCP tools ------------------------------------------------------------------

def mcp_tools() -> dict[str, Any]:
    """{name: registered tool} from the MCP server."""
    import mcp_server

    return {tool.name: tool for tool in mcp_server.mcp._tool_manager.list_tools()}


def tool_function(name: str) -> Any:
    import mcp_server

    return getattr(mcp_server, name, None)


def tool_params(name: str) -> list[str]:
    fn = tool_function(name)
    if fn is None:
        return []
    return [p for p in inspect.signature(fn).parameters if p != "ctx"]


# -- CLI ------------------------------------------------------------------------

def cli_leaves() -> dict[str, list[str]]:
    """{"nebula project new": [dests]} for every leaf command."""
    from cli.__main__ import build_parser

    leaves: dict[str, list[str]] = {}

    def walk(parser: argparse.ArgumentParser, prefix: list[str]) -> None:
        subs = [a for a in parser._actions if isinstance(a, argparse._SubParsersAction)]
        if not subs:
            dests = []
            for action in parser._actions:
                if isinstance(action, argparse._HelpAction) or action.dest in dests:
                    continue
                dests.append(action.dest)
            leaves[" ".join(["nebula", *prefix])] = dests
            return
        for sub in subs:
            seen: set[int] = set()
            for name, child in sub.choices.items():
                if id(child) in seen:
                    continue
                seen.add(id(child))
                walk(child, [*prefix, name])

    walk(build_parser(), [])
    return leaves


# -- events ---------------------------------------------------------------------

def event_kinds() -> set[str]:
    from services.canvas_events import EVENT_KINDS

    return set(EVENT_KINDS)


def execution_event_types() -> set[str]:
    """The typed run events manager.broadcast sends (models/events.py)."""
    from models import events

    types: set[str] = set()
    for _, cls in inspect.getmembers(events, inspect.isclass):
        field = getattr(cls, "model_fields", {}).get("type")
        if field is not None and isinstance(field.default, str):
            types.add(field.default)
    return types


def _py_files(names: Iterable[str]) -> list[Path]:
    files: list[Path] = []
    for name in names:
        path = BACKEND / name
        files.extend(sorted(path.rglob("*.py")) if path.is_dir() else [path])
    return [f for f in files if "tests" not in f.relative_to(BACKEND).parts]


class _Module:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.tree = ast.parse(path.read_text(encoding="utf-8"))
        self.functions: dict[str, ast.AST] = {}
        for node in ast.walk(self.tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.functions.setdefault(node.name, node)
        self.parents: dict[ast.AST, ast.AST] = {}
        for node in ast.walk(self.tree):
            for child in ast.iter_child_nodes(node):
                self.parents[child] = node

    def enclosing_function(self, node: ast.AST) -> ast.AST | None:
        while node in self.parents:
            node = self.parents[node]
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return node
        return None


def broadcast_types() -> tuple[dict[str, list[str]], list[str]]:
    """See _broadcast_types (the scan runs once per process; this returns a copy)."""
    found, unreadable = _broadcast_types()
    return {k: list(v) for k, v in found.items()}, list(unreadable)


@functools.lru_cache(maxsize=1)
def _broadcast_types() -> tuple[dict[str, list[str]], list[str]]:
    """({type: [file:line]}, [unreadable call sites]) for every message passed to
    manager.broadcast_raw/_others/_browser, plus the typed run events.

    A message must be built where the guard can read its "type": a dict
    literal, a name assigned one in the same function, or a call to a function
    (here or in services/) that returns one."""
    modules = {p: _Module(p) for p in _py_files(BROADCAST_FILES)}
    by_name: dict[str, list[tuple[_Module, ast.AST]]] = {}
    for module in modules.values():
        for name, fn in module.functions.items():
            by_name.setdefault(name, []).append((module, fn))

    found: dict[str, list[str]] = {t: ["models/events.py"] for t in execution_event_types()}
    unreadable: list[str] = []

    def from_dict(module: _Module, scope: ast.AST | None, node: ast.Dict, seen: set) -> set[str] | None:
        types: set[str] = set()
        for key, value in zip(node.keys, node.values):
            # A literal "type" names the message whatever is spread around it.
            if isinstance(key, ast.Constant) and key.value == "type" and isinstance(value, ast.Constant):
                return {value.value} if isinstance(value.value, str) else None
        for key, value in zip(node.keys, node.values):
            if key is None:  # **spread
                inner = resolve(module, scope, value, seen)
                if inner is None:
                    return None
                types |= inner
            elif isinstance(key, ast.Constant) and key.value == "type":
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    types.add(value.value)
                else:
                    return None
        return types

    def returns_of(module: _Module, fn: ast.AST, seen: set) -> set[str] | None:
        types: set[str] = set()
        returns = [n for n in ast.walk(fn) if isinstance(n, ast.Return) and n.value is not None]
        if not returns:
            return None
        for ret in returns:
            inner = resolve(module, fn, ret.value, seen)
            if inner is None:
                return None
            types |= inner
        return types

    def resolve(module: _Module, scope: ast.AST | None, node: ast.AST, seen: set) -> set[str] | None:
        if isinstance(node, ast.Dict):
            return from_dict(module, scope, node, seen)
        if isinstance(node, ast.Name) and scope is not None:
            values = [a.value for a in ast.walk(scope) if isinstance(a, (ast.Assign, ast.AnnAssign))
                      and any(isinstance(t, ast.Name) and t.id == node.id
                              for t in (a.targets if isinstance(a, ast.Assign) else [a.target]))
                      and a.value is not None]
            if not values:
                return None
            types: set[str] = set()
            for value in values:
                inner = resolve(module, scope, value, seen)
                if inner is None:
                    return None
                types |= inner
            return types
        if isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
            if name is None or name in seen:
                return None
            if name[:1].isupper():  # a typed event class
                return {t for t in execution_event_types()} if name.endswith("Event") else None
            candidates = by_name.get(name) or []
            if not candidates:
                return None
            types = set()
            for cand_module, fn in candidates:
                inner = returns_of(cand_module, fn, seen | {name})
                if inner is None:
                    return None
                types |= inner
            return types
        return None

    for module in modules.values():
        for node in ast.walk(module.tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr in BROADCAST_METHODS and node.args):
                continue
            receiver = node.func.value
            if isinstance(receiver, ast.Name) and receiver.id == "self":
                continue  # the manager's own fan-out
            where = f"{module.path.relative_to(BACKEND)}:{node.lineno}"
            types = resolve(module, module.enclosing_function(node), node.args[0], set())
            if types is None:
                unreadable.append(where)
                continue
            for kind in types:
                found.setdefault(kind, []).append(where)
        # What the canvas socket's own handler sends one socket (a hello's answer).
        for fn in _canvas_socket_handlers(module):
            for node in ast.walk(fn):
                message = _socket_send_message(node)
                if message is None:
                    continue
                where = f"{module.path.relative_to(BACKEND)}:{node.lineno}"
                types = resolve(module, fn, message, set()) if message is not _UNREADABLE else None
                if types is None:
                    unreadable.append(where)
                    continue
                for kind in types:
                    found.setdefault(kind, []).append(where)
    return found, unreadable


_UNREADABLE = ast.Constant(value=None)


def _canvas_socket_handlers(module: _Module) -> list[ast.AST]:
    """Functions decorated @<app or router>.websocket("<CANVAS_SOCKET>")."""
    out = []
    for fn in module.functions.values():
        for deco in getattr(fn, "decorator_list", []):
            if (isinstance(deco, ast.Call) and isinstance(deco.func, ast.Attribute) and deco.func.attr == "websocket"
                    and deco.args and isinstance(deco.args[0], ast.Constant) and deco.args[0].value == CANVAS_SOCKET):
                out.append(fn)
    return out


def _socket_send_message(node: ast.AST) -> ast.AST | None:
    """The message of ``ws.send_json(m)`` / ``ws.send_text(json.dumps(m))``;
    _UNREADABLE when the text isn't a json.dumps call; None for anything else."""
    if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr in ("send_json", "send_text") and node.args):
        return None
    arg = node.args[0]
    if node.func.attr == "send_json":
        return arg
    if (isinstance(arg, ast.Call) and isinstance(arg.func, ast.Attribute) and arg.func.attr == "dumps"
            and arg.args):
        return arg.args[0]
    return _UNREADABLE


# -- internal params ------------------------------------------------------------

_INTERNAL_KEY = re.compile(r"^_[A-Za-z][A-Za-z0-9_]*$")


def backend_internal_params() -> dict[str, list[str]]:
    return {k: list(v) for k, v in _backend_internal_params().items()}


@functools.lru_cache(maxsize=1)
def _backend_internal_params() -> dict[str, list[str]]:
    """{"_key": [file:line]} for every "_" key the backend reads off node params
    (``params.get("_x")``, ``params["_x"]``; any receiver whose name says param)."""
    found: dict[str, list[str]] = {}
    for path in _py_files(PARAM_SCAN_DIRS):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        # Module-level NAME = "_key" constants, so params.pop(NAME) counts too.
        constants = {t.id: stmt.value.value for stmt in tree.body if isinstance(stmt, ast.Assign)
                     and isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, str)
                     for t in stmt.targets if isinstance(t, ast.Name)}

        def text(node: ast.AST) -> str | None:
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                return node.value
            return constants.get(node.id) if isinstance(node, ast.Name) else None

        for node in ast.walk(tree):
            key, receiver = None, None
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr in ("get", "pop", "setdefault") and node.args
                    and text(node.args[0]) is not None):
                key, receiver = text(node.args[0]), node.func.value
            elif isinstance(node, ast.Subscript) and text(node.slice) is not None:
                key, receiver = text(node.slice), node.value
            if key is None or not _INTERNAL_KEY.match(key):
                continue
            name = receiver.id if isinstance(receiver, ast.Name) else (
                receiver.attr if isinstance(receiver, ast.Attribute) else "")
            if "param" not in name.lower():
                continue
            found.setdefault(key, []).append(f"{path.relative_to(BACKEND)}:{node.lineno}")
    return found


def billing_params() -> set[str]:
    from services.node_route import BILLING_PARAMS

    return set(BILLING_PARAMS)


# -- MCP-side sources ------------------------------------------------------------

# The modules MCP tools send their HTTP calls from. A Tool/ReadOnly row's
# route must be reached from one of them (a path literal that matches it).
MCP_CALLERS = ("mcp_server.py", "moodboard_client.py", "character_client.py", "nebula_api.py")
_HOLE = "\x00"


def _path_literals(path: Path) -> list[str]:
    """"/api..." strings in a module; f-string holes and concatenated non-literals
    become _HOLE."""
    tree = ast.parse(path.read_text(encoding="utf-8"))

    def text(node: ast.AST) -> str | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.JoinedStr):
            return "".join(v.value if isinstance(v, ast.Constant) else _HOLE for v in node.values)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left, right = text(node.left), text(node.right)
            if left is None and right is None:
                return None
            return (left if left is not None else _HOLE) + (right if right is not None else _HOLE)
        return None

    found = []
    for node in ast.walk(tree):
        value = text(node)
        if value and value.startswith("/api"):
            found.append(value)
    return found


def mcp_path_literals() -> list[str]:
    out: list[str] = []
    for name in MCP_CALLERS:
        out.extend(_path_literals(BACKEND / name))
    return out


def literal_reaches(literal: str, route_path: str) -> bool:
    """Whether a path literal (with holes) can be a request to this route."""
    sample = re.sub(r"\{[^}]+\}", "X1", route_path)
    pattern = "".join(".+" if ch == _HOLE else re.escape(ch) for ch in literal.split("?", 1)[0])
    if re.fullmatch(pattern, sample):
        return True
    return bool(route_regex(route_path).fullmatch(literal.replace(_HOLE, "X1").split("?", 1)[0]))


# -- docs -----------------------------------------------------------------------

def doc_words(path: Path = MCP_DOC) -> set[str]:
    """Every identifier inside backticks in docs/MCP-SETUP.md."""
    words: set[str] = set()
    for span in re.findall(r"`([^`\n]+)`", path.read_text(encoding="utf-8")):
        words |= set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", span))
    return words


def docs_gaps() -> set[str]:
    """"tool" or "tool.arg" for each tool and argument the doc doesn't name."""
    words = doc_words()
    gaps: set[str] = set()
    for name in mcp_tools():
        if name not in words:
            gaps.add(name)
        gaps |= {f"{name}.{arg}" for arg in tool_params(name) if arg not in words}
    return gaps


# -- checks ---------------------------------------------------------------------
# Each returns problems as sentences that say exactly what to change.

MANIFEST = "backend/agent_surface.py"
TABLES = ("ROUTES", "CLI", "EVENTS", "INTERNAL_PARAMS", "FRONTEND_NOT_PARAMS", "FRONTEND_ACTIONS")
SETS = ("GAPS_2026_10_20", "DOCS_GAPS_2026_10_20")
_ISSUE = re.compile(r"^(U([1-9]|1[0-6])|Q([1-9]|1[01]))(\+(U([1-9]|1[0-6])|Q([1-9]|1[01])))*$")
_ROW_HINT = ('Tool("<mcp tool>") if an MCP tool calls it, ReadOnly("<read tool>") for a read, '
             'Propose("propose_change") or PersonOnly("<why>") if it is the person\'s call (and gated), '
             'or Exempt("<reason>") with a reason from EXEMPT_REASONS')


def check_layout(path: Path = BACKEND / "agent_surface.py") -> list[str]:
    """Tables and sets are literals with one sorted, unique key per line."""
    problems: list[str] = []
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        target = node.target if isinstance(node, ast.AnnAssign) else (
            node.targets[0] if isinstance(node, ast.Assign) and len(node.targets) == 1 else None)
        name = getattr(target, "id", None)
        if name in TABLES:
            if not isinstance(node.value, ast.Dict):
                problems.append(f"{MANIFEST}: {name} must stay a dict literal")
                continue
            keys = [k.value for k in node.value.keys if isinstance(k, ast.Constant)]
            lines = [k.lineno for k in node.value.keys if isinstance(k, ast.Constant)]
        elif name in SETS:
            call = node.value
            arg = call.args[0] if isinstance(call, ast.Call) and call.args else None
            if not isinstance(arg, ast.Set):
                problems.append(f"{MANIFEST}: {name} must stay frozenset({{...}})")
                continue
            keys = [e.value for e in arg.elts if isinstance(e, ast.Constant)]
            lines = [e.lineno for e in arg.elts if isinstance(e, ast.Constant)]
        else:
            continue
        seen: set[str] = set()
        for key in keys:
            if key in seen:
                problems.append(f'{MANIFEST}: "{key}" is in {name} twice; keep one row')
            seen.add(key)
        for before, after in zip(keys, keys[1:]):
            if after < before:
                problems.append(f'{MANIFEST}: {name} is out of order: put "{after}" before "{before}" '
                                f"(rows stay sorted so parallel PRs don't collide)")
                break
        if len(set(lines)) != len(lines):
            problems.append(f"{MANIFEST}: {name} has two rows on one line; keep one row per line")
    return problems


def _tools_of(row: Any) -> list[str]:
    names = [row.name] if hasattr(row, "name") else []
    if getattr(row, "view", None):
        names.append(row.view)
    return names + list(getattr(row, "also", ()))


def check_rows() -> list[str]:
    """Every row's own shape: known tools, closed reasons, issue ids, via targets."""
    from services import krea_agent_mcp

    tools = mcp_tools()
    listed = set(krea_agent_mcp.NEBULA_MCP_TOOLS)
    kinds = event_kinds()
    allowed = {
        "ROUTES": (surface.Tool, surface.ReadOnly, surface.Propose, surface.PersonOnly, surface.Exempt, surface.Gap),
        "CLI": (surface.Tool, surface.PersonOnly, surface.Exempt, surface.Gap),
        "EVENTS": (surface.ReadOnly, surface.Journal, surface.Exempt, surface.Gap),
        "INTERNAL_PARAMS": (surface.Tool, surface.Propose, surface.Exempt, surface.Gap),
        "FRONTEND_ACTIONS": (surface.Tool, surface.ReadOnly, surface.Propose, surface.Exempt, surface.Gap),
    }
    problems: list[str] = []
    for table, types in allowed.items():
        for key, row in getattr(surface, table).items():
            where = f'{table}["{key}"]'
            if not isinstance(row, types):
                problems.append(f"{where} is {type(row).__name__}; {table} rows are "
                                + "/".join(t.__name__ for t in types))
                continue
            for name in _tools_of(row):
                if name not in tools:
                    problems.append(f'{where} names MCP tool "{name}", which mcp_server.py doesn\'t register')
                elif name not in listed:
                    problems.append(f'{where}: add "{name}" to NEBULA_MCP_TOOLS (services/krea_agent_mcp.py)')
            if isinstance(row, surface.ReadOnly) and row.name in tools:
                hint = tools[row.name].annotations
                if not (hint and hint.readOnlyHint):
                    problems.append(f'{where} is ReadOnly but "{row.name}" isn\'t annotated readOnlyHint=True; '
                                    f'use Tool("{row.name}")')
            if isinstance(row, surface.Exempt) and row.reason not in surface.EXEMPT_REASONS:
                problems.append(f'{where}: Exempt reason "{row.reason}" isn\'t one of EXEMPT_REASONS '
                                f"({', '.join(sorted(surface.EXEMPT_REASONS))})")
            for issue in ([row.issue] if isinstance(row, surface.Gap) else []) + (
                    [row.partial] if getattr(row, "partial", "") else []):
                if not _ISSUE.match(issue):
                    problems.append(f'{where}: "{issue}" isn\'t an audit unit (U1-U16) or question (Q1-Q11) of '
                                    "2026-10-20; a new feature can't be a Gap, give it a real row")
            if (isinstance(row, surface.Gap) or getattr(row, "partial", "")) and key not in surface.GAPS_2026_10_20:
                problems.append(f'{where} is a gap, but "{key}" isn\'t in GAPS_2026_10_20, which may only shrink. '
                                f"Give it a real row: {_ROW_HINT}")
            via = getattr(row, "via", "")
            if via:
                target = surface.ROUTES.get(via)
                if target is None:
                    problems.append(f'{where}: via "{via}" isn\'t a ROUTES key')
                elif row.name not in _tools_of(target):
                    problems.append(f'{where}: via "{via}" but that row doesn\'t name "{row.name}"')
            if isinstance(row, surface.Journal):
                for kind in row.kinds.split():
                    pattern = kind[:-1] if kind.endswith(".*") else None
                    if not (kind in kinds or (pattern and any(k.startswith(pattern) for k in kinds))):
                        problems.append(f'{where}: journal kind "{kind}" isn\'t in canvas_events.EVENT_KINDS')
            for dest, arg in getattr(row, "args", {}).items():
                if isinstance(arg, surface.Gap) and f"{key} --{dest}" not in surface.GAPS_2026_10_20:
                    problems.append(f'{where}: --{dest} is a gap, but "{key} --{dest}" isn\'t in GAPS_2026_10_20')
                if isinstance(arg, surface.Exempt) and arg.reason not in surface.EXEMPT_REASONS:
                    problems.append(f'{where}: --{dest} Exempt reason "{arg.reason}" isn\'t in EXEMPT_REASONS')
    return problems


def gap_keys() -> set[str]:
    """Keys the manifest marks as a gap (Gap rows, partial rows, CLI options)."""
    keys: set[str] = set()
    for table in ("ROUTES", "CLI", "EVENTS", "INTERNAL_PARAMS", "FRONTEND_ACTIONS"):
        for key, row in getattr(surface, table).items():
            if isinstance(row, surface.Gap) or getattr(row, "partial", ""):
                keys.add(key)
            for dest, arg in getattr(row, "args", {}).items():
                if isinstance(arg, surface.Gap):
                    keys.add(f"{key} --{dest}")
    return keys


def check_gaps() -> list[str]:
    stale = sorted(surface.GAPS_2026_10_20 - gap_keys())
    return [f'"{key}" has a real agent path now: delete it from GAPS_2026_10_20 in {MANIFEST}' for key in stale]


def check_routes(app: Any) -> list[str]:
    found = app_routes(app)
    problems = [f'{key} has no row: add "{key}": ... to ROUTES in {MANIFEST} ({_ROW_HINT})'
                for key in sorted(set(found) - set(surface.ROUTES))]
    problems += [f'ROUTES["{key}"]: main.app no longer serves it; delete the row'
                 for key in sorted(set(surface.ROUTES) - set(found))]
    problems += [f'main.app serves "{path}" as a {kind}, which the guard can\'t key or check: serve it from an '
                 f"APIRouter (app.include_router) or an @app route so each method and path gets a ROUTES row"
                 for path, kind in unreadable_routes(app)]
    return problems


def check_gates(app: Any) -> list[str]:
    """Person-only rows show a gate the guard can see; tool rows have none."""
    found = app_routes(app)
    problems: list[str] = []
    for key, row in surface.ROUTES.items():
        route = found.get(key)
        if route is None or key.startswith("WS "):
            continue
        gate = route_gate(route)
        if isinstance(row, (surface.PersonOnly, surface.Propose)) and gate is None:
            problems.append(f"ROUTES[\"{key}\"] is {type(row).__name__} but agents get through: its handler "
                            f"never calls require_person(current_request_headers()) first thing (nor depends "
                            f"on person_only/human_dep). Gate it, or if agents may do it, give it a Tool row")
        if isinstance(row, surface.Gap) and gate is not None:
            problems.append(f'ROUTES["{key}"] is Gap("{row.issue}") but the route is person-gated now: make it '
                            f'PersonOnly("<why>") or Propose("<tool>") and delete "{key}" from GAPS_2026_10_20')
        if isinstance(row, (surface.Tool, surface.ReadOnly)) and gate is not None:
            problems.append(f'ROUTES["{key}"] is {type(row).__name__}("{row.name}") but the route refuses '
                            f"agents ({gate} gate), so the tool can't work; make it PersonOnly or Propose")
    return problems


def check_tool_routes() -> list[str]:
    """A Tool/ReadOnly route (without via) is called from the MCP side."""
    literals = mcp_path_literals()
    problems = []
    for key, row in surface.ROUTES.items():
        if not isinstance(row, (surface.Tool, surface.ReadOnly)) or row.via:
            continue
        path = key.split(" ", 1)[1]
        if not any(literal_reaches(literal, path) for literal in literals):
            problems.append(f'ROUTES["{key}"] says {type(row).__name__}("{row.name}"), but no MCP code '
                            f"({', '.join(MCP_CALLERS)}) calls {path}. Call it from the tool, or name the "
                            f'route the tool calls instead with via="METHOD /path"')
    return problems


def check_tools_covered() -> list[str]:
    named = {name for table in ("ROUTES", "CLI", "EVENTS", "INTERNAL_PARAMS", "FRONTEND_ACTIONS")
             for row in getattr(surface, table).values() for name in _tools_of(row)}
    return [f'MCP tool "{name}" isn\'t named by any row; add Tool("{name}") to the ROUTES row of the route it calls'
            for name in sorted(set(mcp_tools()) - named)]


def check_cli() -> list[str]:
    leaves = cli_leaves()
    problems = [f'"{leaf}" has no row: add "{leaf}": Tool("<mcp tool>") (or Exempt/PersonOnly) to CLI in {MANIFEST}'
                for leaf in sorted(set(leaves) - set(surface.CLI))]
    problems += [f'CLI["{leaf}"]: the CLI no longer has it; delete the row' for leaf in sorted(set(surface.CLI) - set(leaves))]
    for leaf, row in surface.CLI.items():
        if leaf not in leaves or not isinstance(row, surface.Tool):
            continue
        params = {p for name in _tools_of(row) for p in tool_params(name)}
        for dest in leaves[leaf]:
            if dest in surface.PRESENTATION_ARGS:
                continue
            mapped = row.args.get(dest, dest)
            if isinstance(mapped, (surface.Gap, surface.Exempt)):
                continue
            if mapped not in params:
                problems.append(f'CLI["{leaf}"]: option {dest} has no MCP equivalent in '
                                f"{'/'.join(_tools_of(row))} ({', '.join(sorted(params)) or 'no arguments'}). "
                                f'Add the argument to the tool, or map it: args={{"{dest}": "<tool argument>"}}')
        for dest in row.args:
            if dest not in leaves[leaf]:
                problems.append(f'CLI["{leaf}"]: args maps "{dest}", which the command no longer has')
    return problems


def check_events() -> list[str]:
    types, unreadable = broadcast_types()
    found = {f"kind {k}" for k in event_kinds()} | {f"ws {t}" for t in types}
    problems = [f'"{key}" has no row: add it to EVENTS in {MANIFEST} with the journal kind agents see it as '
                f'(Journal("node.added")), the tool that reads it (ReadOnly("get_run")), or add a journal kind'
                for key in sorted(found - set(surface.EVENTS))]
    problems += [f'EVENTS["{key}"]: nothing sends it any more; delete the row' for key in sorted(set(surface.EVENTS) - found)]
    problems += [f"{where}: the guard can't read this broadcast's message type; build the message as a dict "
                 f'literal with a literal "type" (or return one from a helper)' for where in unreadable]
    return problems


def check_internal_params() -> list[str]:
    missing = sorted(set(backend_internal_params()) - billing_params() - set(surface.INTERNAL_PARAMS))
    return [f'node param "{key}" is read by the backend but has no row: add "{key}": ... to INTERNAL_PARAMS in '
            f"{MANIFEST}. Agents can't send \"_\" params, so name the tool that writes it server-side"
            for key in missing]


def check_annotations() -> list[str]:
    problems = []
    for name, tool in sorted(mcp_tools().items()):
        hint = tool.annotations
        if hint is None or hint.readOnlyHint is None or hint.openWorldHint is None:
            problems.append(f'MCP tool "{name}": register it with _tool(annotations=...) setting readOnlyHint '
                            "and openWorldHint")
        elif not hint.readOnlyHint and hint.destructiveHint is None:
            problems.append(f'MCP tool "{name}" changes things: set destructiveHint in its annotations')
    return problems


def check_docs() -> list[str]:
    gaps = docs_gaps()
    problems = [f'docs/MCP-SETUP.md never names `{gap.split(".")[0]}`' + (
        f' argument `{gap.split(".", 1)[1]}`' if "." in gap else "") + ": document it in the tool list"
        for gap in sorted(gaps - surface.DOCS_GAPS_2026_10_20)]
    problems += [f'"{gap}" is documented now: delete it from DOCS_GAPS_2026_10_20 in {MANIFEST}'
                 for gap in sorted(surface.DOCS_GAPS_2026_10_20 - gaps)]
    return problems


def check_mcp_imports() -> list[str]:
    """Tools stay on the HTTP path: the MCP server never imports main or a store."""
    tree = ast.parse((BACKEND / "mcp_server.py").read_text(encoding="utf-8"))
    problems = []
    for node in ast.walk(tree):
        names = ([a.name for a in node.names] if isinstance(node, ast.Import)
                 else [node.module or ""] + [f"{node.module}.{a.name}" for a in node.names]
                 if isinstance(node, ast.ImportFrom) else [])
        for name in names:
            last = name.rsplit(".", 1)[-1]
            if name == "main" or name.startswith("main.") or last.endswith("_store"):
                problems.append(f"mcp_server.py:{node.lineno} imports {name}; a tool must call the HTTP route "
                                "the UI uses (_canvas_call / NebulaAPI), never the backend's code directly")
    return problems


def all_problems(app: Any | None = None) -> list[str]:
    if app is None:
        import main

        app = main.app
    return (check_layout() + check_rows() + check_gaps() + check_routes(app) + check_gates(app)
            + check_tool_routes() + check_tools_covered() + check_cli() + check_events()
            + check_internal_params() + check_annotations() + check_docs() + check_mcp_imports()
            + check_export())


# -- export ---------------------------------------------------------------------

def export() -> dict[str, Any]:
    """The manifest as JSON for frontend/scripts/check-agent-surface.mjs."""
    return {
        "generatedBy": "cd backend && .venv/bin/python agent_surface_check.py --write",
        "routes": {key: surface.row_dict(row) for key, row in surface.ROUTES.items()},
        "internalParams": {key: surface.row_dict(row) for key, row in surface.INTERNAL_PARAMS.items()},
        "backendParams": sorted(backend_internal_params()),
        "frontendActions": {key: surface.row_dict(row) for key, row in surface.FRONTEND_ACTIONS.items()},
        "frontendNotParams": dict(surface.FRONTEND_NOT_PARAMS),
        "gaps": sorted(surface.GAPS_2026_10_20),
        "exemptReasons": sorted(surface.EXEMPT_REASONS),
    }


def export_text() -> str:
    return json.dumps(export(), indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def check_export() -> list[str]:
    current = EXPORT_PATH.read_text(encoding="utf-8") if EXPORT_PATH.exists() else ""
    if current != export_text():
        return [f"{EXPORT_PATH.relative_to(REPO)} is out of date with {MANIFEST}: run "
                "`cd backend && .venv/bin/python agent_surface_check.py --write` and commit it"]
    return []


# Where the backend keeps the person's state. The helper points every one of
# them (and HOME, which ~/.nebula defaults hang off) at a throwaway folder.
STATE_ENV = ("NEBULA_SETTINGS_PATH", "NEBULA_STATE_DIR", "NEBULA_OUTPUT_ROOT", "NEBULA_MOODBOARD_ROOT",
             "NEBULA_CHARACTER_ROOT", "NEBULA_PRESET_ROOT", "NEBULA_COMMONS_ROOT")


def isolate_state() -> Path:
    """Run in a fresh temp state before anything imports main: importing it
    seeds ~/.nebula (presets, lock files, projects/) and reads settings. The
    guard needs only the app's route table, never the person's state."""
    import atexit
    import os
    import shutil
    import tempfile

    root = Path(tempfile.mkdtemp(prefix="nebula-agent-surface-"))
    atexit.register(shutil.rmtree, root, True)
    (root / "home").mkdir()
    os.environ["HOME"] = str(root / "home")
    for name in STATE_ENV:
        os.environ[name] = str(root / ("settings.json" if name == "NEBULA_SETTINGS_PATH" else name.lower()))
    os.environ["NEBULA_COMMONS_NO_STARTUP_SCAN"] = "1"
    os.environ["NEBULA_NO_ASSET_REHOME"] = "1"
    return root


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--write", action="store_true", help=f"rewrite {EXPORT_PATH.relative_to(REPO)}")
    args = parser.parse_args(argv)
    if "main" in sys.modules:
        raise SystemExit("agent_surface_check.main() must run before anything imports main (it isolates state)")
    isolate_state()
    if args.write:
        EXPORT_PATH.write_text(export_text(), encoding="utf-8")
        print(f"wrote {EXPORT_PATH.relative_to(REPO)}")
    problems = all_problems()
    for problem in problems:
        print(problem)
    print("The canvas side (/api calls, graphStore actions, \"_\" params): node frontend/scripts/check-agent-surface.mjs")
    if not problems:
        print("Backend: every route, CLI command, event and internal param has a matching row.")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
