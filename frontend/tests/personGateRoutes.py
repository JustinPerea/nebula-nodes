"""Every backend route behind the person gate, read with ast (PR #204 rounds 6 to 9).

Run by tests/personGatedCallers.ts (gatedRoutes, unreadableRouteForms). Prints JSON:

    {"routes": [{method, path, handler}, ...],
     "unreadable": [{file, line, form, handler, method, path, gated}, ...]}

    python3 -I personGateRoutes.py <backend dir>
    python3 -I personGateRoutes.py --stdin      # {"files": {"main.py": "...", "routes/x.py": "..."}}

What it reads: the source of every .py file under the backend dir, except tests/, test/,
__pycache__/, node_modules/, site-packages/, hidden dirs and virtualenvs (venv/, env/, or any dir
with a pyvenv.cfg). It parses them with ast and never imports or runs them.

A route is gated when its handler reaches a gate form, directly or through any function, method,
lambda, decorator or Depends() dependency in those files:

- a call of require_person, _person_only_refusal, stop_refusal or person_only, or one passed as a
  value (a callback, Depends(person_only));
- outside services/person_gate.py: PersonGateError (or a class whose bases lead to it, round 9)
  built or raised (an `except PersonGateError` or an isinstance() isn't a gate, round 8),
  PERSON_REQUIRED written, or the refusal code "person_required" anywhere outside a comparison or
  a docstring, written or through a string constant (the chat socket's refusals, rounds 8 and 9);
- Depends(...) on a gate in the route's dependencies=, a parameter default, its router's
  APIRouter(dependencies=[...]), an include_router(..., dependencies=[...]) that mounts it, or the
  app's FastAPI(dependencies=[...]);
- a decorator whose own body reaches a gate (a wrapper that checks, then calls the route).

Names are followed through imports (inside functions too, relative ones, dotted module chains),
aliases, lambda aliases, module-level instances (gate = Gate(); gate.check() is Gate.check),
self/cls, getattr(x, "name") with a constant name, and string constants for paths and prefixes
(a name, a module attribute, an f-string or a + of those). Routes come from @app/@router
decorators (any verb, api_route, websocket), app.add_api_route(...) and the like, on a FastAPI
app or an APIRouter (also one built by a function that returns APIRouter(...)), with the prefixes
of every include_router that mounts the router. A router that nothing includes is read as mounted
at the root.

Unreadable, listed and never skipped: a route decorator or add_*route call on an owner that isn't
an app or a router it can read; a path or prefix it can't evaluate to a string; methods= it can't
read (method "*"); dependencies= it can't read; an endpoint it can't find; include_router of
something it can't read as a router, or onto something that isn't an app or router; an app or
router mounted with mount() (and each route on it: its path is under the mount's); a handler that
reads a gate out of a container by subscript (CHECKS["p"](...), round 8) or uses such a container
any other way (a for loop over it, CHECKS.get("p"), handing it on: round 9); an unknown decorator
on an app or router; a middleware that reaches a gate (it would gate routes the list can't
name); a file that doesn't parse.
"""
from __future__ import annotations

import ast
import json
import os
import sys

GATES = {"require_person", "_person_only_refusal", "stop_refusal", "person_only"}
INLINE = {"PERSON_REQUIRED"}  # any use
GATE_ERROR = "PersonGateError"  # built or raised only
REFUSAL_CODE = "person_required"  # written as a value
CONTAINERS = (ast.Dict, ast.List, ast.Tuple, ast.Set)
VERBS = {"get", "post", "put", "patch", "delete", "head", "options", "trace"}
MULTI = {"api_route", "route"}  # methods= decides
SOCKETS = {"websocket", "websocket_route"}
ROUTE_ATTRS = VERBS | MULTI | SOCKETS
ADD_ROUTE = {"add_api_route": "GET", "add_route": "GET", "add_api_websocket_route": "WS", "add_websocket_route": "WS"}
# App and router decorators that don't make a route.
NOT_ROUTES = {"on_event", "exception_handler", "middleware"}
SKIP_DIRS = {"tests", "test", "__pycache__", "node_modules", "site-packages", "venv", "env"}
GATE_FILE = "services/person_gate.py"


def load(argv: list[str]) -> dict[str, str]:
    if argv[1:2] == ["--stdin"]:
        return json.load(sys.stdin)["files"]
    root = argv[1]
    files: dict[str, str] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")
                             and not os.path.exists(os.path.join(dirpath, d, "pyvenv.cfg")))
        for name in sorted(filenames):
            if name.endswith(".py"):
                path = os.path.join(dirpath, name)
                with open(path, encoding="utf8") as handle:
                    files[os.path.relpath(path, root).replace(os.sep, "/")] = handle.read()
    return files


class Module:
    def __init__(self, rel: str, source: str) -> None:
        self.rel = rel.replace(os.sep, "/")
        parts = self.rel[:-3].split("/")
        self.is_package = parts[-1] == "__init__"
        if self.is_package:
            parts = parts[:-1]
        self.name = ".".join(parts) or "__init__"
        self.label = "main" if self.rel == "main.py" else self.rel.split("/")[-1][:-3]
        self.error: str | None = None
        self.error_line = 0
        try:
            self.tree: ast.Module = ast.parse(source)
        except SyntaxError as error:
            self.error = error.msg
            self.error_line = error.lineno or 0
            self.tree = ast.Module(body=[], type_ignores=[])


class Entity:
    """A module-level name: module, def, class, alias, instance, call, router, app or const."""

    def __init__(self, kind: str, module: Module | None, node: ast.AST | None = None, target: str | None = None,
                 cls: str | None = None) -> None:
        self.kind = kind
        self.module = module
        self.node = node
        self.target = target
        self.cls = cls


ENT: dict[str, Entity] = {}
CANON: dict[str, str] = {}
WALKS: dict[int, list[ast.AST]] = {}


def walk(node: ast.AST) -> list[ast.AST]:
    """ast.walk, kept: the same defs are read several times."""
    if id(node) not in WALKS:
        WALKS[id(node)] = list(ast.walk(node))
    return WALKS[id(node)]


def top_level(body: list[ast.stmt]):
    """Module statements, also those under if/try/with."""
    for statement in body:
        yield statement
        if isinstance(statement, ast.If):
            yield from top_level(statement.body)
            yield from top_level(statement.orelse)
        elif isinstance(statement, (ast.With, ast.AsyncWith)):
            yield from top_level(statement.body)
        elif isinstance(statement, ast.Try) or type(statement).__name__ == "TryStar":
            yield from top_level(statement.body)
            for handler in statement.handlers:
                yield from top_level(handler.body)
            yield from top_level(statement.orelse)
            yield from top_level(statement.finalbody)


def import_source(module: Module, node: ast.ImportFrom) -> str:
    if not node.level:
        return node.module or ""
    package = module.name.split(".") if module.is_package else module.name.split(".")[:-1]
    if node.level > 1:
        package = package[: len(package) - (node.level - 1)]
    return ".".join(package + ([node.module] if node.module else []))


def import_names(module: Module, node: ast.AST) -> list[tuple[str, str]]:
    """(local name, qualified target) for an import statement."""
    if isinstance(node, ast.ImportFrom):
        source = import_source(module, node)
        return [(a.asname or a.name, f"{source}.{a.name}" if source else a.name) for a in node.names if a.name != "*"]
    if isinstance(node, ast.Import):
        return [(a.asname, a.name) if a.asname else (a.name.split(".")[0], a.name.split(".")[0]) for a in node.names]
    return []


def source_text(node: ast.AST | None) -> str:
    return ast.unparse(node) if node is not None else "?"


def callee_text(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{callee_text(node.value)}.{node.attr}"
    return ""


def register(module: Module) -> None:
    def put(local: str, entity: Entity) -> None:
        q = f"{module.name}.{local}"
        if q in ENT and ENT[q].kind == "module" and entity.kind == "alias":
            return
        ENT[q] = entity

    for node in top_level(module.tree.body):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            put(node.name, Entity("def", module, node))
        elif isinstance(node, ast.ClassDef):
            cq = f"{module.name}.{node.name}"
            put(node.name, Entity("class", module, node))
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    ENT[f"{cq}.{item.name}"] = Entity("def", module, item, cls=cq)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for local, target in import_names(module, node):
                put(local, Entity("alias", module, target=target))
        elif isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    put(target.id, value_entity(module, node.value))


def value_entity(module: Module, value: ast.AST) -> Entity:
    if isinstance(value, ast.Lambda):
        return Entity("def", module, value)
    if isinstance(value, (ast.Constant, ast.JoinedStr, ast.BinOp)):
        return Entity("const", module, value)
    if isinstance(value, ast.Call):
        text = callee_text(value.func).split(".")[-1]
        if text == "APIRouter":
            return Entity("router", module, value)
        if text == "FastAPI":
            return Entity("app", module, value)
        return Entity("call", module, value)  # settled in settle()
    return Entity("alias", module, value)


def settle() -> None:
    """A module-level `x = f(...)`: an instance of a class, a router a function returns, or a value."""
    for q, entity in list(ENT.items()):
        if entity.kind != "call":
            continue
        call = entity.node
        assert isinstance(call, ast.Call)
        func = callee_text(call.func)
        if func == "getattr":
            entity.kind = "alias"
            continue
        target = expr_q(entity.module, call.func, None, {})
        found = ENT.get(target or "")
        if found and found.kind == "class":
            entity.kind, entity.target = "instance", target
        elif found and found.kind == "def" and isinstance(found.node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            returned = [n.value for n in ast.walk(found.node) if isinstance(n, ast.Return) and n.value is not None]
            if returned and all(isinstance(r, ast.Call) and callee_text(r.func).split(".")[-1] == "APIRouter" for r in returned):
                entity.kind, entity.node, entity.module = "router", returned[0], found.module
                continue
            entity.kind = "def"
        else:
            entity.kind = "def"  # a value built by a call: its call and arguments are its edges


def canon(q: str, depth: int = 0) -> str:
    if depth > 40:
        return q
    if depth == 0 and q in CANON:
        return CANON[q]
    result = q
    entity = ENT.get(q)
    if entity is not None:
        if entity.kind == "alias":
            target = entity.target if entity.target is not None else expr_q(entity.module, entity.node, None, {}, depth + 1)
            if target and target != q:
                result = canon(target, depth + 1)
    else:
        parts = q.split(".")
        for i in range(len(parts) - 1, 0, -1):
            head, rest = ".".join(parts[:i]), ".".join(parts[i:])
            found = ENT.get(head)
            if found is None:
                continue
            if found.kind == "alias":
                resolved = canon(head, depth + 1)
                if resolved != head:
                    result = canon(f"{resolved}.{rest}", depth + 1)
            elif found.kind == "instance" and found.target:
                result = canon(f"{canon(found.target, depth + 1)}.{rest}", depth + 1)
            break
    if depth == 0:
        CANON[q] = result
    return result


def expr_q(module: Module | None, node: ast.AST | None, cls: str | None, local: dict[str, str], depth: int = 0) -> str | None:
    """The qualified name an expression refers to (a bare name when it isn't defined in the files)."""
    if module is None or node is None or depth > 40:
        return None
    if isinstance(node, ast.Name):
        if node.id in local:
            return canon(local[node.id], depth)
        q = f"{module.name}.{node.id}"
        if q in ENT:
            return canon(q, depth)
        if node.id in ("self", "cls") and cls:
            return cls
        return node.id
    if isinstance(node, ast.Attribute):
        base = expr_q(module, node.value, cls, local, depth + 1)
        if base:
            return canon(f"{base}.{node.attr}", depth)
        return node.attr if node.attr in GATES else None
    if isinstance(node, ast.Call):
        if callee_text(node.func) == "getattr" and len(node.args) >= 2 and isinstance(node.args[1], ast.Constant) \
                and isinstance(node.args[1].value, str):
            base = expr_q(module, node.args[0], cls, local, depth + 1)
            return canon(f"{base}.{node.args[1].value}", depth) if base else None
        target = expr_q(module, node.func, cls, local, depth + 1)
        found = ENT.get(target or "")
        if found is not None and found.kind == "class":
            return target  # Gate().check is Gate.check
    return None


LOCALS: dict[int, dict[str, str]] = {}


def local_scope(module: Module, fn: ast.AST, cls: str | None) -> dict[str, str]:
    """Imports and plain aliases inside a function."""
    if id(fn) in LOCALS:
        return LOCALS[id(fn)]
    LOCALS[id(fn)] = local = {}
    for inner in walk(fn):
        if not isinstance(inner, (ast.Import, ast.ImportFrom, ast.Assign)):
            continue
        for name, target in import_names(module, inner):
            local[name] = target
        if isinstance(inner, ast.Assign) and len(inner.targets) == 1 and isinstance(inner.targets[0], ast.Name) \
                and isinstance(inner.value, (ast.Name, ast.Attribute, ast.Call)):
            if isinstance(inner.value, ast.Call) and callee_text(inner.value.func) != "getattr":
                continue
            q = expr_q(module, inner.value, cls, local)
            if q:
                local[inner.targets[0].id] = q
    return local


def is_gate(q: str | None) -> bool:
    return bool(q) and q.split(".")[-1] in GATES


def is_route_decorator(decorator: ast.AST) -> bool:
    func = decorator.func if isinstance(decorator, ast.Call) else decorator
    return isinstance(func, ast.Attribute) and func.attr in ROUTE_ATTRS | NOT_ROUTES


def roots_of(node: ast.AST) -> list[ast.AST]:
    """What a def runs: its body and parameter defaults, and custom decorators (not route ones)."""
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return [node.args, *node.body, *[d for d in node.decorator_list if not is_route_decorator(d)]]
    if isinstance(node, ast.Lambda):
        return [node.args, node.body]
    return [node]


EDGES: dict[int, set[str]] = {}


def edges_of(module: Module, node: ast.AST, cls: str | None) -> set[str]:
    if id(node) in EDGES:
        return EDGES[id(node)]
    EDGES[id(node)] = out = edges_from(module, node, cls)
    return out


def edges_from(module: Module, node: ast.AST, cls: str | None) -> set[str]:
    local = local_scope(module, node, cls)
    out: set[str] = set()
    roots = roots_of(node)
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        # A custom decorator used bare (@person_required) is reached too.
        for decorator in node.decorator_list:
            if not is_route_decorator(decorator) and isinstance(decorator, (ast.Name, ast.Attribute)):
                target = expr_q(module, decorator, cls, local)
                if target:
                    out.add(target)
    for root in roots:
        for inner in walk(root):
            if not isinstance(inner, ast.Call):
                continue
            target = expr_q(module, inner.func, cls, local)
            if target:
                out.add(target)
                found = ENT.get(target)
                if found is not None and found.kind == "class":
                    out.add(f"{target}.__init__")
            # A function passed as a value (Depends(person_only), a callback) counts as reached.
            for arg in [*inner.args, *[k.value for k in inner.keywords]]:
                if isinstance(arg, (ast.Name, ast.Attribute)):
                    value = expr_q(module, arg, cls, local)
                    if value:
                        out.add(value)
    return out


def names_gate_error(module: Module, node: ast.AST | None, cls: str | None, local: dict[str, str]) -> bool:
    if isinstance(node, ast.Name) and node.id == GATE_ERROR or isinstance(node, ast.Attribute) and node.attr == GATE_ERROR:
        return True
    q = expr_q(module, node, cls, local) if isinstance(node, (ast.Name, ast.Attribute)) else None
    return is_gate_error(q)


def is_gate_error(q: str | None, depth: int = 0) -> bool:
    """PersonGateError, or a class in the files whose bases lead to it (round 9)."""
    if not q or depth > 20:
        return False
    if q.split(".")[-1] == GATE_ERROR:
        return True
    entity = ENT.get(q)
    if entity is None or entity.kind != "class" or not isinstance(entity.node, ast.ClassDef):
        return False
    return any(is_gate_error(expr_q(entity.module, base, None, {}), depth + 1) for base in entity.node.bases)


def is_refusal_code(module: Module, node: ast.AST | None, local: dict[str, str]) -> bool:
    if not isinstance(node, (ast.Constant, ast.Name, ast.Attribute, ast.JoinedStr, ast.BinOp)):
        return False
    return eval_str(module, node, local) == REFUSAL_CODE


def read_only(root: ast.AST) -> set[int]:
    """The nodes that only read a value: a comparison's operands (and what is inside them), and
    docstrings (any statement that is only a string)."""
    out: set[int] = set()
    for inner in walk(root):
        if isinstance(inner, ast.Compare):
            for operand in [inner.left, *inner.comparators]:
                out.update(id(n) for n in walk(operand))
        if isinstance(inner, ast.Expr) and isinstance(inner.value, ast.Constant) and isinstance(inner.value.value, str):
            out.add(id(inner.value))
    return out


def inline_gate(module: Module, node: ast.AST, cls: str | None = None) -> bool:
    """A gate written in the def itself: PersonGateError built or raised, PERSON_REQUIRED, or the
    "person_required" refusal code as a value. Not in services/person_gate.py, which defines them.
    Round 9: the code counts anywhere outside a comparison or a docstring (a subscript set, a local,
    a positional argument), written or through a string constant."""
    if module.rel == GATE_FILE:
        return False
    local = local_scope(module, node, cls)
    for root in roots_of(node):
        reads = read_only(root)
        for inner in walk(root):
            if id(inner) not in reads and isinstance(inner, ast.Constant) and inner.value == REFUSAL_CODE:
                return True
            if id(inner) not in reads and (isinstance(inner, (ast.Name, ast.Attribute)) and isinstance(inner.ctx, ast.Load)
                                           or isinstance(inner, (ast.JoinedStr, ast.BinOp))) and is_refusal_code(module, inner, local):
                return True
            if isinstance(inner, ast.Name) and inner.id in INLINE:
                return True
            if isinstance(inner, ast.Attribute) and inner.attr in INLINE:
                return True
            if isinstance(inner, ast.Call) and names_gate_error(module, inner.func, cls, local):
                return True
            if isinstance(inner, ast.Raise) and names_gate_error(module, inner.exc, cls, local):
                return True
            if isinstance(inner, ast.Dict) and any(is_refusal_code(module, v, local) for v in inner.values):
                return True
            if isinstance(inner, ast.Call) and any(is_refusal_code(module, k.value, local) for k in inner.keywords):
                return True
    return False


def holds_gate(module: Module | None, node: ast.AST | None, cls: str | None, local: dict[str, str],
               literals: dict[str, ast.AST], depth: int = 0) -> bool:
    """A container literal with a gate in it, or a name for one (module-level, or assigned in the def)."""
    if module is None or node is None or depth > 10:
        return False
    if isinstance(node, ast.Subscript):
        return holds_gate(module, node.value, cls, local, literals, depth + 1)
    if isinstance(node, ast.Name) and node.id in literals:
        return holds_gate(module, literals[node.id], cls, local, {}, depth + 1)
    if isinstance(node, (ast.Name, ast.Attribute)):
        entity = ENT.get(expr_q(module, node, cls, local) or "")
        if entity is None or entity.kind != "alias" or not isinstance(entity.node, CONTAINERS):
            return False
        return holds_gate(entity.module, entity.node, None, {}, {}, depth + 1)
    if isinstance(node, CONTAINERS):
        for inner in ast.walk(node):
            if isinstance(inner, (ast.Name, ast.Attribute)):
                q = expr_q(module, inner, cls, local)
                if is_gate(q) or q in GATED:
                    return True
    return False


def subscript_gate(module: Module, node: ast.AST, cls: str | None = None) -> bool:
    """The def reads a gate out of a container by subscript (CHECKS["p"](...)): it can't tell
    which entry runs, so the route is listed as unreadable."""
    local = local_scope(module, node, cls)
    literals = container_names(node)
    for root in roots_of(node):
        for inner in walk(root):
            if isinstance(inner, ast.Subscript) and holds_gate(module, inner.value, cls, local, literals):
                return True
    return False


def container_names(node: ast.AST) -> dict[str, ast.AST]:
    return {inner.targets[0].id: inner.value for inner in walk(node)
            if isinstance(inner, ast.Assign) and len(inner.targets) == 1 and isinstance(inner.targets[0], ast.Name)
            and isinstance(inner.value, CONTAINERS)}


def held_gate(module: Module, node: ast.AST, cls: str | None = None) -> bool:
    """Round 9: the def uses a container that holds a gate some other way (a for loop over it,
    CHECKS.get("p"), handing it on): fail safe, the route is listed as unreadable."""
    local = local_scope(module, node, cls)
    literals = container_names(node)
    for root in roots_of(node):
        for inner in walk(root):
            if isinstance(inner, ast.Subscript):
                continue
            if isinstance(inner, (ast.Name, ast.Attribute)) and isinstance(inner.ctx, ast.Load) \
                    and holds_gate(module, inner, cls, local, literals):
                return True
            if isinstance(inner, CONTAINERS) and not isinstance(getattr(inner, "ctx", ast.Load()), ast.Store) \
                    and holds_gate(module, inner, cls, local, literals) and not depends_on_gate(module, inner, local):
                return True
    return False


GATED: set[str] = set()
SUBSCRIPTED: set[str] = set()  # defs that reach a gate read by subscript
HELD: set[str] = set()  # defs that reach a gate container used some other way (round 9)


def reaches(module: Module, node: ast.AST, cls: str | None) -> bool:
    return inline_gate(module, node, cls) or any(is_gate(t) or t in GATED for t in edges_of(module, node, cls))


def reaches_subscript(module: Module, node: ast.AST, cls: str | None) -> str | None:
    """The unreadable form for a def that reaches a gate read out of a container, or None."""
    if subscript_gate(module, node, cls) or any(t in SUBSCRIPTED for t in edges_of(module, node, cls)):
        return "reads a gate by subscript"
    if held_gate(module, node, cls) or any(t in HELD for t in edges_of(module, node, cls)):
        return "reads a gate out of a container"
    return None


def held_form(q: str | None) -> str | None:
    return "reads a gate by subscript" if q in SUBSCRIPTED else "reads a gate out of a container" if q in HELD else None


def spread(found: set[str], calls: dict[str, set[str]]) -> None:
    grew = True
    while grew:
        grew = False
        for q, out in calls.items():
            if q not in found and out & found:
                found.add(q)
                grew = True


def compute_gated() -> None:
    defs = {q: e for q, e in ENT.items() if e.kind == "def"}
    calls: dict[str, set[str]] = {}
    for q, entity in defs.items():
        calls[q] = edges_of(entity.module, entity.node, entity.cls)
        if is_gate(q) or inline_gate(entity.module, entity.node, entity.cls) or any(is_gate(t) for t in calls[q]):
            GATED.add(q)
    spread(GATED, calls)
    for q, entity in defs.items():
        if subscript_gate(entity.module, entity.node, entity.cls):
            SUBSCRIPTED.add(q)
        if held_gate(entity.module, entity.node, entity.cls):
            HELD.add(q)
    spread(SUBSCRIPTED, calls)
    spread(HELD, calls)


def depends_on_gate(module: Module, node: ast.AST | None, local: dict[str, str] | None = None) -> bool:
    if node is None:
        return False
    for inner in ast.walk(node):
        if isinstance(inner, ast.Call) and callee_text(inner.func).split(".")[-1] in ("Depends", "Security"):
            args = list(inner.args) + [k.value for k in inner.keywords if k.arg == "dependency"]
            for arg in args[:1]:
                q = expr_q(module, arg, None, local or {})
                if is_gate(q) or q in GATED or is_gate(callee_text(arg)):
                    return True
    return False


def eval_str(module: Module | None, node: ast.AST | None, local: dict[str, str] | None = None, depth: int = 0) -> str | None:
    if module is None or node is None or depth > 20:
        return None
    if isinstance(node, ast.Constant):
        return node.value if isinstance(node.value, str) else None
    if isinstance(node, ast.JoinedStr):
        parts = []
        for value in node.values:
            if isinstance(value, ast.FormattedValue):
                if value.conversion not in (-1, None) or value.format_spec is not None:
                    return None
                part = eval_str(module, value.value, local, depth + 1)
            else:
                part = eval_str(module, value, local, depth + 1)
            if part is None:
                return None
            parts.append(part)
        return "".join(parts)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = eval_str(module, node.left, local, depth + 1)
        right = eval_str(module, node.right, local, depth + 1)
        return left + right if left is not None and right is not None else None
    if isinstance(node, (ast.Name, ast.Attribute)):
        entity = ENT.get(expr_q(module, node, None, local or {}) or "")
        if entity is not None and entity.kind == "const":
            return eval_str(entity.module, entity.node, None, depth + 1)
    return None


def keyword(call: ast.Call, name: str) -> ast.AST | None:
    for k in call.keywords:
        if k.arg == name:
            return k.value
    return None


def arg(call: ast.Call, index: int, name: str) -> ast.AST | None:
    return call.args[index] if len(call.args) > index else keyword(call, name)


def router_info(entity: Entity) -> dict:
    """prefix (None when it can't be read), gated, and unreadable dependencies."""
    call = entity.node
    assert isinstance(call, ast.Call)
    prefix_node = keyword(call, "prefix")
    prefix = "" if prefix_node is None else eval_str(entity.module, prefix_node)
    deps = keyword(call, "dependencies")
    gated = depends_on_gate(entity.module, deps)
    return {"prefix": prefix, "gated": gated, "deps_unread": deps is not None and not gated and not isinstance(deps, (ast.List, ast.Tuple))}


class Reader:
    def __init__(self, modules: list[Module]) -> None:
        self.modules = modules
        self.routes: list[dict] = []
        self.unreadable: list[dict] = []
        self.mounts: dict[str, list[tuple[str, str | None, bool]]] = {}  # router -> (parent, prefix, gated)
        self.mounted: set[str] = set()  # apps and routers mounted with mount()

    def unread(self, module: Module, node: ast.AST, form: str, handler: str | None = None, method: str | None = None,
               path: str | None = None, gated: bool | None = None) -> None:
        self.unreadable.append({"file": module.rel, "line": getattr(node, "lineno", 0), "form": form,
                                "handler": handler, "method": method, "path": path, "gated": gated})

    def owner(self, module: Module, node: ast.AST, local: dict[str, str]) -> tuple[str | None, Entity | None]:
        q = expr_q(module, node, None, local)
        entity = ENT.get(q or "")
        if entity is not None and entity.kind in ("app", "router"):
            return q, entity
        return q, None

    def read_includes(self) -> None:
        for module in self.modules:
            for call in walk(module.tree):
                if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Attribute):
                    continue
                attr = call.func.attr
                if attr not in ("include_router", "mount"):
                    continue
                parent_q, parent = self.owner(module, call.func.value, {})
                if attr == "mount":
                    child_q = expr_q(module, arg(call, 1, "app"), None, {})
                    child = ENT.get(child_q or "")
                    if child is not None and child.kind in ("app", "router"):
                        self.unread(module, call, "an app or router mounted with mount()")
                        self.mounted.add(child_q)
                    continue
                text = callee_text(call.func.value) or "?"
                if parent is None:
                    self.unread(module, call, f"include_router on {text}, not an app or router it can read")
                    continue
                child_q = expr_q(module, arg(call, 0, "router"), None, {})
                child = ENT.get(child_q or "")
                if child is None or child.kind != "router":
                    self.unread(module, call, f"include_router of {source_text(arg(call, 0, 'router'))}, not a router it can read")
                    continue
                prefix_node = keyword(call, "prefix")
                prefix = "" if prefix_node is None else eval_str(module, prefix_node)
                if prefix is None:
                    self.unread(module, call, "include_router prefix= it can't read")
                deps = keyword(call, "dependencies")
                gated = depends_on_gate(module, deps)
                if deps is not None and not gated and not isinstance(deps, (ast.List, ast.Tuple)):
                    self.unread(module, call, "include_router dependencies= it can't read")
                self.mounts.setdefault(child_q, []).append((parent_q, prefix, gated))

    def mounts_of(self, q: str, seen: frozenset = frozenset()) -> list[tuple[str | None, bool]]:
        """(path before the router's own prefix, gated from outside) for every place it's mounted."""
        sites = self.mounts.get(q)
        if not sites or q in seen:
            return [("", False)]
        out: list[tuple[str | None, bool]] = []
        for parent_q, prefix, gated in sites:
            parent = ENT[parent_q]
            if parent.kind == "app":
                outer = gated or depends_on_gate(parent.module, keyword(parent.node, "dependencies"))
                out.append((None if parent_q in self.mounted else prefix, outer))
                continue
            info = router_info(parent)
            for before, outer in self.mounts_of(parent_q, seen | {q}):
                path = None if before is None or info["prefix"] is None or prefix is None else before + info["prefix"] + prefix
                out.append((path, outer or info["gated"] or gated))
        return out

    def route(self, module: Module, site: ast.AST, owner_node: ast.AST, owner_local: dict[str, str], methods: list[str] | None,
              path_node: ast.AST | None, deps: ast.AST | None, handler: str, handler_gated: bool, form: str,
              subscripted: str | None = None) -> None:
        owner_q, owner = self.owner(module, owner_node, owner_local)
        path = eval_str(module, path_node, owner_local)
        deps_gated = depends_on_gate(module, deps, owner_local)
        gated = handler_gated or deps_gated
        if owner is None:
            self.unread(module, site, f"{form} on {callee_text(owner_node) or '?'}, not an app or router it can read",
                        handler, ",".join(methods or ["*"]), path, gated)
            return
        if path is None:
            self.unread(module, site, f"{form} with a path it can't read", handler, ",".join(methods or ["*"]), None, gated)
            return
        if methods is None:
            self.unread(module, site, f"{form} with methods= it can't read", handler, "*", path, gated)
            return
        if deps is not None and not deps_gated and not isinstance(deps, (ast.List, ast.Tuple)):
            self.unread(module, site, f"{form} with dependencies= it can't read", handler, ",".join(methods), path, gated)
            return
        if owner_q in self.mounted:
            self.unread(module, site, f"{form} on an app or router mounted with mount()", handler, ",".join(methods), path, gated)
            return
        if owner.kind == "app":
            places = [("", depends_on_gate(owner.module, keyword(owner.node, "dependencies")))]
            own_prefix = ""
        else:
            info = router_info(owner)
            if info["deps_unread"]:
                self.unread(module, site, f"{form} on a router whose dependencies= it can't read", handler, ",".join(methods), path, gated)
                return
            places = self.mounts_of(owner_q)
            own_prefix = info["prefix"]
            gated = gated or info["gated"]
        for before, outer in places:
            if before is None or own_prefix is None:
                self.unread(module, site, f"{form} on a router whose prefix it can't read", handler, ",".join(methods), path, gated or outer)
                continue
            if gated or outer:
                for method in methods:
                    self.routes.append({"method": method, "path": before + own_prefix + path, "handler": handler})
            elif subscripted:
                self.unread(module, site, f"{form} whose handler {subscripted}", handler, ",".join(methods),
                            before + own_prefix + path, False)

    def methods_of(self, module: Module, node: ast.AST | None, default: str) -> list[str] | None:
        if node is None:
            return [default]
        if not isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            return None
        values = [eval_str(module, e) for e in node.elts]
        return None if any(v is None for v in values) else [v.upper() for v in values]

    def read_decorators(self, module: Module) -> None:
        classes = {id(item): f"{module.name}.{node.name}" for node in walk(module.tree) if isinstance(node, ast.ClassDef)
                   for item in node.body}
        for fn in walk(module.tree):
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            cls = classes.get(id(fn))
            handler = f"{module.label}.{fn.name}"
            handler_gated: bool | None = None
            subscripted: str | None = None
            for decorator in fn.decorator_list:
                call = decorator if isinstance(decorator, ast.Call) else None
                func = call.func if call else decorator
                if not isinstance(func, ast.Attribute):
                    continue
                attr = func.attr
                if handler_gated is None and (attr in ROUTE_ATTRS or attr in NOT_ROUTES):
                    handler_gated = reaches(module, fn, cls)
                    subscripted = reaches_subscript(module, fn, cls)
                if attr in NOT_ROUTES:
                    _, owner = self.owner(module, func.value, {})
                    if owner is not None and attr == "middleware" and handler_gated:
                        self.unread(module, decorator, "a middleware that reaches a gate", handler, None, None, True)
                    continue
                if attr not in ROUTE_ATTRS:
                    _, owner = self.owner(module, func.value, {})
                    if owner is not None:
                        self.unread(module, decorator, f"@{callee_text(func)}, an app/router decorator it doesn't know", handler)
                    continue
                if call is None:
                    self.unread(module, decorator, f"@{callee_text(func)} without a call", handler)
                    continue
                if attr in VERBS:
                    methods: list[str] | None = [attr.upper()]
                elif attr in SOCKETS:
                    methods = ["WS"]
                else:
                    methods = self.methods_of(module, keyword(call, "methods"), "GET")
                self.route(module, decorator, func.value, {}, methods, arg(call, 0, "path"), keyword(call, "dependencies"),
                           handler, bool(handler_gated), f"@{callee_text(func) or '?'}", subscripted)

    def read_calls(self, module: Module) -> None:
        for call in walk(module.tree):
            if not isinstance(call, ast.Call):
                continue
            func = call.func
            # app.add_api_route(path, endpoint, ...)
            if isinstance(func, ast.Attribute) and func.attr in ADD_ROUTE:
                form = callee_text(func) or func.attr
                endpoint = arg(call, 1, "endpoint")
                handler, gated, subscripted = self.endpoint(module, endpoint)
                if handler is None:
                    self.unread(module, call, f"{form} with an endpoint it can't find", None, None, eval_str(module, arg(call, 0, "path")))
                    continue
                methods = self.methods_of(module, keyword(call, "methods"), ADD_ROUTE[func.attr])
                self.route(module, call, func.value, {}, methods, arg(call, 0, "path"), keyword(call, "dependencies"), handler, gated, form,
                           subscripted)
            # app.post("/x")(endpoint): a route decorator used as a call
            elif isinstance(func, ast.Call) and isinstance(func.func, ast.Attribute) and func.func.attr in ROUTE_ATTRS and call.args:
                _, owner = self.owner(module, func.func.value, {})
                if owner is None:
                    continue
                handler, gated, subscripted = self.endpoint(module, call.args[0])
                if handler is None:
                    self.unread(module, call, f"{callee_text(func.func)}(...)(...) with an endpoint it can't find")
                    continue
                attr = func.func.attr
                methods = [attr.upper()] if attr in VERBS else ["WS"] if attr in SOCKETS else self.methods_of(module, keyword(func, "methods"), "GET")
                self.route(module, call, func.func.value, {}, methods, arg(func, 0, "path"), keyword(func, "dependencies"), handler, gated,
                           f"{callee_text(func.func)}(...)(...)", subscripted)
            # app.add_middleware(SomeMiddleware): its dispatch or __call__ reaching a gate
            elif isinstance(func, ast.Attribute) and func.attr == "add_middleware" and call.args:
                target = expr_q(module, call.args[0], None, {})
                if target and any(f"{target}.{name}" in GATED for name in ("dispatch", "__call__", "__init__")):
                    self.unread(module, call, "a middleware that reaches a gate", target.split(".")[-1], None, None, True)

    def endpoint(self, module: Module, node: ast.AST | None) -> tuple[str | None, bool, str | None]:
        """(handler, gated, how it reads a gate out of a container)"""
        if isinstance(node, ast.Lambda):
            return f"{module.label}.<lambda>", reaches(module, node, None), reaches_subscript(module, node, None)
        q = expr_q(module, node, None, {})
        entity = ENT.get(q or "")
        if entity is None or entity.kind != "def" or entity.module is None:
            return None, False, None
        name = getattr(entity.node, "name", (q or "").split(".")[-1])
        return f"{entity.module.label}.{name}", q in GATED or is_gate(q), held_form(q)


def main(argv: list[str]) -> None:
    files = load(argv)
    modules = [Module(rel, source) for rel, source in files.items()]
    for module in modules:
        parts = module.name.split(".")
        for i in range(1, len(parts) + 1):
            ENT.setdefault(".".join(parts[:i]), Entity("module", None))
        ENT[module.name] = Entity("module", module)
    for module in modules:
        register(module)
    settle()
    CANON.clear()
    compute_gated()
    reader = Reader(modules)
    for module in modules:
        if module.error:
            reader.unread(module, module.tree, "a file that doesn't parse")
            reader.unreadable[-1]["line"] = module.error_line
    reader.read_includes()
    for module in modules:
        reader.read_decorators(module)
        reader.read_calls(module)
    routes = sorted({json.dumps(r, sort_keys=True) for r in reader.routes})
    out_routes = sorted((json.loads(r) for r in routes), key=lambda r: (r["path"], r["method"], r["handler"]))
    unreadable = sorted(reader.unreadable, key=lambda u: (u["file"], u["line"], u["form"]))
    json.dump({"routes": out_routes, "unreadable": unreadable}, sys.stdout, indent=1)


if __name__ == "__main__":
    main(sys.argv)
