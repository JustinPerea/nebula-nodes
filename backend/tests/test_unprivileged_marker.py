"""Root ignores file permissions. A test that makes a file unreadable or a
folder unwritable with chmod passes or fails for the wrong reason as root, and
Claude Code cloud sessions run as root. Such tests carry
@pytest.mark.unprivileged, which tests/conftest.py skips as root (CI runs them
as a normal user). This file finds every chmod in the tests that takes away
the owner's read or write bit and checks the tests that reach it are marked."""
from __future__ import annotations

import ast
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests import conftest

TESTS = Path(__file__).resolve().parent
OWNER_RW = stat.S_IRUSR | stat.S_IWUSR


def _mode(node: ast.AST) -> int | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, int):
        return node.value
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "stat":
        value = getattr(stat, node.attr, None)
        return value if isinstance(value, int) else None
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        left, right = _mode(node.left), _mode(node.right)
        return None if left is None or right is None else left | right
    return None


def _chmod_mode(call: ast.Call) -> ast.AST | None:
    """The mode of os.chmod(path, mode), path.chmod(mode) or either with mode=."""
    func = call.func
    if not (isinstance(func, ast.Attribute) and func.attr in {"chmod", "lchmod", "fchmod"}):
        return None
    for keyword in call.keywords:
        if keyword.arg == "mode":
            return keyword.value
    if isinstance(func.value, ast.Name) and func.value.id == "os":
        return call.args[1] if len(call.args) > 1 else None
    return call.args[0] if call.args else None


def drops_owner_access(function: ast.AST) -> list[int]:
    """Lines in `function` where a chmod takes away the owner's read or write."""
    lines = []
    for node in ast.walk(function):
        if isinstance(node, ast.Call) and (mode := _chmod_mode(node)) is not None:
            value = _mode(mode)
            if value is not None and value & OWNER_RW != OWNER_RW:
                lines.append(node.lineno)
    return lines


MARK = "pytest.mark.unprivileged"
Function = ast.FunctionDef | ast.AsyncFunctionDef


def _says_mark(nodes: list[ast.expr]) -> bool:
    return any(MARK in ast.unparse(node) for node in nodes)


def _pytestmark(body: list[ast.stmt]) -> bool:
    return any(
        isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "pytestmark" for target in node.targets)
        and _says_mark([node.value])
        for node in body
    )


def _uses(function: Function) -> set[str]:
    """Names a function calls (f() or self.f()) or takes as fixtures."""
    names = {arg.arg for arg in function.args.args + function.args.kwonlyargs}
    for node in ast.walk(function):
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                names.add(node.func.id)
            elif isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) \
                    and node.func.value.id in {"self", "cls"}:
                names.add(node.func.attr)
    return names


def unmarked(source: str) -> list[str]:
    """Tests that reach a chmod dropping the owner's read or write and aren't
    marked. Scope: chmod modes written as int literals or stat constants, in
    module functions and in test classes' methods, followed through helpers
    and fixtures by name. A parametrize with one marked case counts as marked:
    the scan doesn't check that the chmod runs only in that case."""
    tree = ast.parse(source)
    if _pytestmark(tree.body):
        return []
    # (function, marked by its class or module) for every function in scope.
    scope: list[tuple[Function, bool]] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            scope.append((node, False))
        elif isinstance(node, ast.ClassDef):
            class_marked = _says_mark(node.decorator_list) or _pytestmark(node.body)
            methods = [item for item in node.body if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))]
            scope += [(method, class_marked) for method in methods]
    uses = {id(f): _uses(f) for f, _ in scope}
    helpers = [f for f, _ in scope if not f.name.startswith("test")]
    # Helpers and fixtures that drop access, followed through the helpers and
    # fixtures that use them, so a test two steps away is still found.
    dropping = {f.name for f in helpers if drops_owner_access(f)}
    while more := {f.name for f in helpers if f.name not in dropping and uses[id(f)] & dropping}:
        dropping |= more
    return [
        f"{f.name} (line {f.lineno})"
        for f, outer_marked in scope
        if f.name.startswith("test")
        and (drops_owner_access(f) or uses[id(f)] & dropping)
        and not (outer_marked or _says_mark(f.decorator_list))
    ]


def test_every_test_that_takes_away_file_access_is_marked():
    found = {
        path.name: problems
        for path in sorted(TESTS.glob("test_*.py"))
        if (problems := unmarked(path.read_text(encoding="utf-8")))
    }
    assert found == {}, (
        "These tests take a file's read or write permission away with chmod, which root ignores. "
        "Mark each with @pytest.mark.unprivileged (or the case that does it, with pytest.param(..., "
        f"marks=pytest.mark.unprivileged)): {found}"
    )


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("import os\ndef test_a(tmp_path):\n    os.chmod(tmp_path, 0o500)\n", ["test_a (line 2)"]),
        ("def test_a(tmp_path):\n    (tmp_path / 'f').chmod(0)\n", ["test_a (line 1)"]),
        ("import os, stat\ndef test_a(p):\n    os.chmod(p, stat.S_IRUSR | stat.S_IXUSR)\n", ["test_a (line 2)"]),
        ("import os\ndef test_a(p):\n    os.chmod(p, mode=0o400)\n", ["test_a (line 2)"]),
        # Through a helper, a helper's helper, and a fixture.
        ("import os\ndef _h(p):\n    os.chmod(p, 0)\ndef test_a(p):\n    _h(p)\n", ["test_a (line 4)"]),
        ("import os\ndef _h(p):\n    os.chmod(p, 0)\ndef _g(p):\n    _h(p)\ndef test_a(p):\n    _g(p)\n",
         ["test_a (line 6)"]),
        ("import os, pytest\n@pytest.fixture\ndef locked(tmp_path):\n    os.chmod(tmp_path, 0o500)\n"
         "    yield tmp_path\ndef test_a(locked):\n    pass\n", ["test_a (line 6)"]),
        # Marked, a marked case, the whole module, and modes that keep access.
        ("import os, pytest\n@pytest.mark.unprivileged\ndef test_a(p):\n    os.chmod(p, 0)\n", []),
        ("import pytest\n@pytest.mark.parametrize('d', [pytest.param('x', marks=pytest.mark.unprivileged)])\n"
         "def test_a(p, d):\n    p.chmod(0)\n", []),
        ("import os, pytest\npytestmark = [pytest.mark.unprivileged]\ndef test_a(p):\n    os.chmod(p, 0)\n", []),
        ("import os, stat\ndef test_a(p):\n    os.chmod(p, 0o600)\n    os.chmod(p, stat.S_IRWXU)\n", []),
        # Test classes: a method, a method through self.helper, a marked class.
        ("import os\nclass TestA:\n    def test_a(self, p):\n        os.chmod(p, 0)\n", ["test_a (line 3)"]),
        ("import os\nclass TestA:\n    def _lock(self, p):\n        os.chmod(p, 0)\n"
         "    def test_a(self, p):\n        self._lock(p)\n", ["test_a (line 5)"]),
        ("import os, pytest\n@pytest.mark.unprivileged\nclass TestA:\n    def test_a(self, p):\n        os.chmod(p, 0)\n", []),
        # The word alone in pytestmark isn't the mark.
        ("import os\npytestmark = ['unprivileged']\ndef test_a(p):\n    os.chmod(p, 0)\n", ["test_a (line 3)"]),
    ],
)
def test_the_scan_finds_what_it_should(source, expected):
    assert unmarked(source) == expected


@pytest.mark.parametrize(("euid", "skipped"), [(0, True), (501, False)])
def test_the_marker_skips_only_as_root(monkeypatch, euid, skipped):
    monkeypatch.setattr(conftest.os, "geteuid", lambda: euid, raising=False)
    marked = SimpleNamespace(get_closest_marker=lambda name: object() if name == "unprivileged" else None)
    plain = SimpleNamespace(get_closest_marker=lambda name: None)

    def skips(item) -> bool:
        # A skip raised here would skip this test instead of failing it.
        try:
            conftest.pytest_runtest_setup(item)
        except pytest.skip.Exception as skip:
            assert "root ignores file permissions" in str(skip)
            return True
        return False

    assert skips(plain) is False
    assert skips(marked) is skipped
