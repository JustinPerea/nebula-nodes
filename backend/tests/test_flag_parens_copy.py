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
# Round 18m (GM r44 3): terminal help text is exempt by SURFACE, not by file: "(default:
# $NEBULA_URL)" is that medium's convention. A string is help text when it is (part of) the value
# of one of these keywords in any call: argparse's help, description, epilog and usage (CLI help
# and usage), and the description of an MCP tool or parameter (Field(description=...), a tool's
# description=). A tool's docstring is its description too, and docstrings are skipped already.
# Everything else is checked: the CLI's own messages, and the startup lines Nebula prints for the
# person (the sign-in link and its startup errors), which follow the person-copy rules.
HELP_KEYWORDS = frozenset({"help", "description", "epilog", "usage"})


def _docstrings(tree: ast.AST) -> set[int]:
    ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                ids.add(id(body[0].value))
    return ids


def _help_text(tree: ast.AST) -> set[int]:
    """The string constants that are CLI help or usage, or an MCP tool or parameter description."""
    ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            for keyword in node.keywords:
                if keyword.arg in HELP_KEYWORDS:
                    ids.update(id(inner) for inner in ast.walk(keyword.value) if isinstance(inner, ast.Constant))
    return ids


def offenders(source: str, name: str) -> list[str]:
    tree = ast.parse(source)
    skipped = _docstrings(tree) | _help_text(tree)
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skipped:
            if FLAG_IN_PARENS.search(node.value):
                found.append(f"{name}:{node.lineno}: {node.value!r}")
    return found


def test_no_backend_string_puts_a_flag_in_parens():
    found = []
    for path in sorted(BACKEND.rglob("*.py")):
        if SKIP_DIRS & set(path.relative_to(BACKEND).parts):
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


def test_help_text_is_exempt_by_surface_and_nothing_else():
    # CLI help and usage, in any file: a new help file needs no entry.
    assert not offenders("p.add_argument('--url', help='Backend URL (default: $NEBULA_URL)')\n", "new_cli.py")
    assert not offenders("p = argparse.ArgumentParser(description='Runs it (set NEBULA_X)', epilog='(NEBULA_Y)', usage='x (NEBULA_Z)')\n", "n.py")
    assert not offenders("p.add_argument('--u', help=f'URL (default: $NEBULA_URL, else {x})')\n", "n.py")
    # MCP tool and parameter descriptions.
    assert not offenders("def t(x: Annotated[str, Field(description='The URL (default: $NEBULA_URL)')]): ...\n", "n.py")
    assert not offenders("@_tool(description='Reads it (needs NEBULA_X)')\ndef t(): ...\n", "n.py")
    # Not help: a message printed or logged, an error, an assignment.
    assert offenders("print('error: pass --url (or NEBULA_URL_FILE for the desktop app).')\n", "n.py")
    assert offenders("log.warning('Person link unavailable (set NEBULA_DEV_UI_ORIGIN)')\n", "n.py")
    assert offenders("raise SystemExit('Start it (NEBULA_X=1).')\n", "n.py")


def test_the_startup_lines_for_the_person_are_checked():
    """The sign-in link line and its startup errors (services/person_session, devserver) are what the
    app's lines point to ("Open the link Nebula printed..."): the scan reads them, and none is help."""
    expected = {
        "services/person_session.py": ["Open Nebula as you: ", "Person session unavailable", "Person link unavailable"],
        "devserver.py": ["Nebula: no person link", "Nebula: open the canvas as you: ", "Nebula: no terminal to show the person link",
                         "Nebula: opened the canvas as you in your browser.", "Nebula: ignoring "],
    }
    for name, starts in expected.items():
        tree = ast.parse((BACKEND / name).read_text(encoding="utf-8"))
        skipped = _docstrings(tree) | _help_text(tree)
        checked = [node.value for node in ast.walk(tree)
                   if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skipped]
        for start in starts:
            assert any(text.startswith(start) for text in checked), f"{name}: {start!r} is not scanned"


# Round 18n (GM r45 Q2): what the person reads in the terminal uses curly apostrophes, as the app's
# lines do: the startup lines (the sign-in link and its startup errors) and `nebula mcp connect`
# and `disconnect`, which the person runs. Help, description, epilog and usage stay exempt by
# surface. Agents may read the mcp messages too (an agent running the command for the person);
# the words mean the same either way.
PERSON_READ = ("services/person_session.py", "devserver.py", "cli/commands/mcp_connect.py")
STRAIGHT_APOSTROPHE = re.compile(r"\w'\w|^'\w")


def straight_apostrophes(source: str, name: str) -> list[str]:
    tree = ast.parse(source)
    skipped = _docstrings(tree) | _help_text(tree)
    return [f"{name}:{node.lineno}: {node.value!r}" for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skipped
            and STRAIGHT_APOSTROPHE.search(node.value)]


def test_person_read_terminal_lines_use_curly_apostrophes():
    found = []
    for name in PERSON_READ:
        found += straight_apostrophes((BACKEND / name).read_text(encoding="utf-8"), name)
    assert found == []


def test_the_apostrophe_check_catches_what_it_is_for():
    assert straight_apostrophes("print(\"error: Nebula doesn't recognize this token.\")\n", "m.py")
    assert straight_apostrophes("print(f\"so {label}'s config will hold it\")\n", "m.py")
    assert straight_apostrophes("log.warning(\"Pass Nebula's address\")\n", "m.py")
    assert not straight_apostrophes("print(\"error: Nebula doesn’t recognize this token.\")\n", "m.py")
    # Help text is exempt by surface; code inside an f-string's braces isn't text.
    assert not straight_apostrophes("p.add_argument('--x', help=\"it doesn't\")\n", "m.py")
    assert not straight_apostrophes("raise E(f\"{'token' if k else 'file'} in place\")\n", "m.py")
