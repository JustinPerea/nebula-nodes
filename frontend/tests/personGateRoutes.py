"""PR #204 round 6 (review 4 LOW-2): every backend route behind the person gate, read with ast.

Run by tests/personGatedCallers.ts (gatedRoutes). Prints JSON: [{method, path, handler}, ...].

    python3 personGateRoutes.py <backend dir>
    python3 personGateRoutes.py --stdin      # {"files": {"main.py": "...", "routes/x.py": "..."}}

A route is gated when its handler reaches a gate form, directly or through any function in
main.py, routes/ or services/ (by name, through an import or an alias, as a module attribute, or
a class's static method):

- a call of require_person, _person_only_refusal or stop_refusal, or of person_only;
- PersonGateError raised or built, or PERSON_REQUIRED written, outside services/person_gate.py;
- Depends(person_only) in the route decorator's dependencies=, in a parameter's default
  (`_: None = Depends(person_only)`), or in its router's APIRouter(dependencies=[...]).

Decorators may span lines and use either quote; @app.api_route / @router.api_route read their
methods=[...].
"""
from __future__ import annotations

import ast
import json
import os
import sys

GATES = {"require_person", "_person_only_refusal", "stop_refusal", "person_only"}
INLINE = {"PersonGateError", "PERSON_REQUIRED"}
VERBS = {"get", "post", "put", "patch", "delete"}


def module_name(rel: str) -> str:
    return rel[:-3].replace(os.sep, ".").replace("/", ".")


def load(argv: list[str]) -> dict[str, str]:
    if argv[1:2] == ["--stdin"]:
        return json.load(sys.stdin)["files"]
    root = argv[1]
    files: dict[str, str] = {}
    for top in ("main.py",):
        path = os.path.join(root, top)
        if os.path.exists(path):
            files[top] = open(path, encoding="utf8").read()
    for folder in ("routes", "services"):
        base = os.path.join(root, folder)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in ("tests", "__pycache__")]
            for name in filenames:
                if name.endswith(".py"):
                    path = os.path.join(dirpath, name)
                    files[os.path.relpath(path, root)] = open(path, encoding="utf8").read()
    return files


class Module:
    def __init__(self, rel: str, source: str) -> None:
        self.rel = rel
        self.name = module_name(rel)
        self.tree = ast.parse(source)
        # local name -> ("func", qualified) | ("module", module name) | ("class", qualified)
        self.names: dict[str, tuple[str, str]] = {}
        self.functions: dict[str, ast.AST] = {}  # qualified -> def node
        self.routers: dict[str, dict] = {}  # router variable -> {prefix, gated}


def qualify(module: Module, local: str) -> str:
    return f"{module.name}.{local}"


def read_module(module: Module, all_modules: set[str]) -> None:
    for node in module.tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            q = qualify(module, node.name)
            module.functions[q] = node
            module.names[node.name] = ("func", q)
        elif isinstance(node, ast.ClassDef):
            cq = qualify(module, node.name)
            module.names[node.name] = ("class", cq)
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    module.functions[f"{cq}.{item.name}"] = item
        elif isinstance(node, ast.ImportFrom) and node.module:
            source = node.module
            for alias in node.names:
                local = alias.asname or alias.name
                if f"{source}.{alias.name}" in all_modules:
                    module.names[local] = ("module", f"{source}.{alias.name}")
                else:
                    module.names[local] = ("func", f"{source}.{alias.name}")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                module.names[alias.asname or alias.name.split(".")[0]] = ("module", alias.name if alias.asname else alias.name.split(".")[0])
    # Module-level aliases (`gate = require_person`) and routers (`router = APIRouter(...)`).
    for node in module.tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            continue
        target = node.targets[0].id
        value = node.value
        if isinstance(value, (ast.Name, ast.Attribute)):
            resolved = resolve(module, value, None)
            if resolved:
                module.names[target] = ("func", resolved)
        if isinstance(value, ast.Call) and callee_text(value.func).endswith("APIRouter"):
            prefix = ""
            gated = False
            for keyword in value.keywords:
                if keyword.arg == "prefix" and isinstance(keyword.value, ast.Constant):
                    prefix = str(keyword.value.value)
                if keyword.arg == "dependencies" and depends_on_gate(module, keyword.value):
                    gated = True
            module.routers[target] = {"prefix": prefix, "gated": gated}


def callee_text(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{callee_text(node.value)}.{node.attr}"
    return ""


def resolve(module: Module, node: ast.AST, cls: str | None) -> str | None:
    """The qualified function a callee names, or a bare gate name it ends in."""
    if isinstance(node, ast.Name):
        kind = module.names.get(node.id)
        if kind and kind[0] == "func":
            return kind[1]
        if node.id in GATES:
            return node.id
        return None
    if isinstance(node, ast.Attribute):
        base = node.value
        if isinstance(base, ast.Name):
            if base.id in ("self", "cls") and cls:
                return f"{cls}.{node.attr}"
            kind = module.names.get(base.id)
            if kind and kind[0] in ("module", "class"):
                return f"{kind[1]}.{node.attr}"
        if node.attr in GATES:
            return node.attr
    return None


def is_gate(qualified: str | None) -> bool:
    return bool(qualified) and qualified.split(".")[-1] in GATES


def depends_on_gate(module: Module, node: ast.AST) -> bool:
    for inner in ast.walk(node):
        if isinstance(inner, ast.Call) and callee_text(inner.func).split(".")[-1] == "Depends" and inner.args:
            if is_gate(resolve(module, inner.args[0], None)) or callee_text(inner.args[0]).split(".")[-1] in GATES:
                return True
    return False


def inline_gate(module: Module, fn: ast.AST) -> bool:
    if module.rel.replace(os.sep, "/") == "services/person_gate.py":
        return False
    for inner in ast.walk(fn):
        if isinstance(inner, ast.Name) and inner.id in INLINE:
            return True
        if isinstance(inner, ast.Attribute) and inner.attr in INLINE:
            return True
    return False


def owner_class(qualified: str, module: Module) -> str | None:
    parts = qualified[len(module.name) + 1:].split(".")
    return f"{module.name}.{parts[0]}" if len(parts) == 2 else None


def main(argv: list[str]) -> None:
    files = load(argv)
    names = {module_name(rel) for rel in files}
    modules = [Module(rel, source) for rel, source in files.items()]
    for module in modules:
        read_module(module, names)
    by_function: dict[str, tuple[Module, ast.AST]] = {}
    for module in modules:
        for qualified, fn in module.functions.items():
            by_function[qualified] = (module, fn)

    calls: dict[str, set[str]] = {}
    gated: set[str] = set()
    for qualified, (module, fn) in by_function.items():
        cls = owner_class(qualified, module)
        out: set[str] = set()
        for inner in ast.walk(fn):
            if isinstance(inner, ast.Call):
                target = resolve(module, inner.func, cls)
                if target:
                    out.add(target)
                # A gate passed as a value (Depends(person_only), a callback) counts as reached.
                for arg in inner.args:
                    if isinstance(arg, (ast.Name, ast.Attribute)) and is_gate(resolve(module, arg, cls)):
                        out.add(resolve(module, arg, cls) or "")
        calls[qualified] = out
        if any(is_gate(target) for target in out) or inline_gate(module, fn):
            gated.add(qualified)
    for qualified in by_function:
        if is_gate(qualified):
            gated.add(qualified)
    grew = True
    while grew:
        grew = False
        for qualified, out in calls.items():
            if qualified not in gated and out & gated:
                gated.add(qualified)
                grew = True

    routes = []
    for module in modules:
        is_main = module.rel == "main.py"
        label = "main" if is_main else module.rel.split("/")[-1][:-3]
        for qualified, fn in module.functions.items():
            if qualified.count(".") != module.name.count(".") + 1:
                continue
            params_gated = any(depends_on_gate(module, default) for default in
                               list(fn.args.defaults) + [d for d in fn.args.kw_defaults if d is not None])
            for decorator in fn.decorator_list:
                if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                    continue
                owner = callee_text(decorator.func.value)
                verb = decorator.func.attr
                router = module.routers.get(owner)
                if owner != "app" and router is None:
                    continue
                if verb in VERBS:
                    methods = [verb.upper()]
                elif verb == "api_route":
                    methods = []
                    for keyword in decorator.keywords:
                        if keyword.arg == "methods" and isinstance(keyword.value, (ast.List, ast.Tuple)):
                            methods = [str(e.value).upper() for e in keyword.value.elts if isinstance(e, ast.Constant)]
                    methods = methods or ["GET"]
                else:
                    continue
                if not decorator.args or not isinstance(decorator.args[0], ast.Constant):
                    continue
                path = str(decorator.args[0].value)
                dependencies = any(k.arg == "dependencies" and depends_on_gate(module, k.value) for k in decorator.keywords)
                if not (qualified in gated or params_gated or dependencies or (router or {}).get("gated")):
                    continue
                prefix = (router or {}).get("prefix", "")
                for method in methods:
                    routes.append({"method": method, "path": prefix + path, "handler": f"{label}.{fn.name}"})
    routes.sort(key=lambda r: (r["path"], r["method"]))
    json.dump(routes, sys.stdout)


if __name__ == "__main__":
    main(sys.argv)
