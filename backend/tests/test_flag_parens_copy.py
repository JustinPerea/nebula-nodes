"""Person copy names a NEBULA_ flag in the sentence, never in parentheses.

GM r38.1: "Agent review is off on this Nebula. Start it with a call budget
(NEBULA_COMMONS_REVIEW_CALL_BUDGET), then try again." read as an aside the person could skip, when
the flag is the one thing they need. Lines say it plainly instead ("Start Nebula with
NEBULA_COMMONS_REVIEW_CALL_BUDGET set to a call budget"). This scans every string constant in the
backend (docstrings aside, which no person reads) for a flag inside parentheses.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
# Round 18l (review 17 logic NIT-2): anywhere inside the parens, not only first.
FLAG_IN_PARENS = re.compile(r"\([^)]*\bNEBULA_[A-Z0-9_]+")
SKIP_DIRS = {".venv", "tests", "__pycache__", "node_modules"}
# Round 18l: the terminal's own text, for whoever runs the CLI, the dev server or the MCP server by
# hand, where "(default: $NEBULA_URL)" is the usual way to name an environment default. The wider
# pattern finds 17 such strings there and none in what the app shows a person; GM decides whether
# the terminal follows the rule too (a separate copy pass), so they are set aside, by file.
TERMINAL_COPY = ("cli/", "devserver.py", "mcp_server.py")


def _docstrings(tree: ast.AST) -> set[int]:
    ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                ids.add(id(body[0].value))
    return ids


def offenders(source: str, name: str) -> list[str]:
    tree = ast.parse(source)
    docs = _docstrings(tree)
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docs:
            if FLAG_IN_PARENS.search(node.value):
                found.append(f"{name}:{node.lineno}: {node.value!r}")
    return found


def test_no_backend_string_puts_a_flag_in_parens():
    found = []
    for path in sorted(BACKEND.rglob("*.py")):
        if SKIP_DIRS & set(path.relative_to(BACKEND).parts):
            continue
        if path.relative_to(BACKEND).as_posix().startswith(TERMINAL_COPY):
            continue
        found += offenders(path.read_text(encoding="utf-8"), str(path.relative_to(BACKEND)))
    assert found == []


def test_the_scan_catches_a_flag_in_parens():
    # Implicit concatenation still lands in one constant, as the old review line did.
    old = "x = ('Start it with a call budget '\n     '(NEBULA_COMMONS_REVIEW_CALL_BUDGET), then try again.')\n"
    assert offenders(old, "m.py")
    assert not offenders('"""Docstring (NEBULA_X) is fine."""\n', "m.py")
    assert not offenders("y = 'Start Nebula with NEBULA_X set.'\n", "m.py")
    # Round 18l (NIT-2): a flag later in the parens too.
    assert offenders("z = 'Start it (set NEBULA_X=1), then try again.'\n", "m.py")
    assert offenders("z = 'Start it (the budget, NEBULA_X) now.'\n", "m.py")
    assert not offenders("z = 'Start it (now). Restart with NEBULA_X=1.'\n", "m.py")
