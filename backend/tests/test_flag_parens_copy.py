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
#
# The exemption list, by surface (round 18p, GM r59 Q6 and r60 20):
# - help text: the values of HELP_KEYWORDS, and docstrings;
# - terminal prefixes: a line's leading TERMINAL_PREFIXES ("Nebula:", "error:", "note:" and "!") are
#   that medium's convention. Only the prefix is exempt: the checks below read the text after it,
#   which follows the person-copy rules.
HELP_KEYWORDS = frozenset({"help", "description", "epilog", "usage"})
TERMINAL_PREFIXES = ("Nebula:", "error:", "note:", "!")


def after_prefix(text: str) -> str:
    """The text a check reads: a line's leading terminal prefix is exempt, the rest isn't."""
    for prefix in TERMINAL_PREFIXES:
        if text.startswith(prefix):
            return text[len(prefix):]
    return text


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
        "services/person_session.py": ["Open Nebula as you: ", "Nebula couldn’t start the person session",
                                       "Person link unavailable"],
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
# Round 18o (GM r51 Q6): the same lines carry no semicolon and no aside in parentheses either: a
# second clause is its own sentence, and a detail such as the parser's words gets its own line.
PERSON_READ = ("services/person_session.py", "devserver.py", "cli/commands/mcp_connect.py")
STRAIGHT_APOSTROPHE = re.compile(r"\w'\w|^'\w")
SEMICOLON_OR_PARENS = re.compile(r"[;()]")


# Shell code the CLI hands to a shell, not a sentence a person reads: its parens and `$$` are the shell's
# (main's #225 session id, `NEBULA_AGENT_SESSION="cc-$(date +%s)-$$"`).
SHELL_SNIPPETS = {"SESSION_ASSIGNMENT"}


def _shell_snippets(tree: ast.AST) -> set[int]:
    return {id(part) for node in ast.walk(tree)
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in SHELL_SNIPPETS for t in node.targets)
            for part in ast.walk(node.value)}


def _person_read_constants(source: str) -> list[ast.Constant]:
    tree = ast.parse(source)
    skipped = _docstrings(tree) | _help_text(tree) | _shell_snippets(tree)
    return [node for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skipped]


def straight_apostrophes(source: str, name: str) -> list[str]:
    return [f"{name}:{node.lineno}: {node.value!r}" for node in _person_read_constants(source)
            if STRAIGHT_APOSTROPHE.search(after_prefix(node.value))]


def semicolons_or_parens(source: str, name: str) -> list[str]:
    return [f"{name}:{node.lineno}: {node.value!r}" for node in _person_read_constants(source)
            if SEMICOLON_OR_PARENS.search(after_prefix(node.value))]


def test_person_read_terminal_lines_use_curly_apostrophes():
    found = []
    for name in PERSON_READ:
        found += straight_apostrophes((BACKEND / name).read_text(encoding="utf-8"), name)
    assert found == []


def test_person_read_terminal_lines_have_no_semicolon_or_parens():
    found = []
    for name in PERSON_READ:
        found += semicolons_or_parens((BACKEND / name).read_text(encoding="utf-8"), name)
    assert found == []


def test_the_apostrophe_check_catches_what_it_is_for():
    assert straight_apostrophes("print(\"error: Nebula doesn't recognize this token.\")\n", "m.py")
    assert straight_apostrophes("print(f\"so {label}'s config will hold it\")\n", "m.py")
    assert straight_apostrophes("log.warning(\"Pass Nebula's address\")\n", "m.py")
    assert not straight_apostrophes("print(\"error: Nebula doesn’t recognize this token.\")\n", "m.py")
    # Help text is exempt by surface; code inside an f-string's braces isn't text.
    assert not straight_apostrophes("p.add_argument('--x', help=\"it doesn't\")\n", "m.py")
    assert not straight_apostrophes("raise E(f\"{'token' if k else 'file'} in place\")\n", "m.py")


def test_the_semicolon_and_parens_check_catches_what_it_is_for():
    # The old lines GM r51 reworded.
    assert semicolons_or_parens("print(\"error: an in-app agent can’t connect other apps to Nebula; the person runs this.\")\n", "m.py")
    assert semicolons_or_parens("print(\"error: Nebula doesn’t recognize this token (revoked, or from another Nebula).\")\n", "m.py")
    assert semicolons_or_parens("raise E(f\"{path} isn’t valid JSON ({exc}); fix it by hand.\")\n", "m.py")
    assert semicolons_or_parens("log.warning(\"Person link unavailable (no terminal)\")\n", "m.py")
    assert semicolons_or_parens("print(\"x\" + (\" (mode 600)\" if y else \"\"))\n", "m.py")
    assert not semicolons_or_parens("print(\"error: Nebula doesn’t recognize this token. It was revoked.\")\n", "m.py")
    # Help, description, epilog and usage stay exempt by surface; code in an f-string's braces isn't text.
    assert not semicolons_or_parens("p.add_argument('--url', help='Backend URL (default: $NEBULA_URL); or a file')\n", "m.py")
    assert not semicolons_or_parens("p = argparse.ArgumentParser(description='a (b); c', epilog='(d)', usage='e (f)')\n", "m.py")
    assert not semicolons_or_parens("print(f\"Wrote {', '.join(sorted(names))}.\")\n", "m.py")
    assert not semicolons_or_parens('"""A docstring (with an aside); and more."""\n', "m.py")


# Round 18p (GM r59 Q6, r60 19 and 20): nothing introduces a command or a path with a colon. A
# sentence ends with a period and the command goes on the next line ("Run this command."), and a
# path sits in the sentence ("Nebula saved a backup at {backup}."). The check reads each message
# whole, as the person sees it: a printed, logged or raised line, or a prompt, with f-string parts
# and + joins put back together and an `x if c else y` read both ways, an interpolated value shown
# as {its code}. After the terminal prefix (exempt by surface, above), a colon may not be followed by
# a command or a path: a backtick, ~, /, $, --, a `nebula` command, a relative path, a value whose code names a path,
# an argv, a snippet, a command or a file, or the end of a line (what's printed next).
COMMAND_OR_PATH_NAMES = r"(?:path|argv|snippet|backup|command|cmd|file|where)"
COLON_INTRODUCING = re.compile(
    r"(?<=[\w}`’”)]):(?!//)[ \t]*(?:$|\n|[`~/$]|--|nebula\b|[\w.-]+/[\w.]|\{[^}]*\b" + COMMAND_OR_PATH_NAMES + r"\w*\b[^}]*\})",
    re.MULTILINE)


def _messages(node: ast.AST) -> list[str]:
    """Every way an expression can read, with interpolated code as {code}."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.JoinedStr):
        texts = [""]
        for part in node.values:
            texts = [t + p for t in texts for p in _messages(part)]
        return texts
    if isinstance(node, ast.FormattedValue):
        return ["{" + ast.unparse(node.value) + "}"]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return [a + b for a in _messages(node.left) for b in _messages(node.right)]
    if isinstance(node, ast.IfExp):
        return _messages(node.body) + _messages(node.orelse)
    return ["{" + ast.unparse(node) + "}"]


def _is_text(node: ast.AST) -> bool:
    if isinstance(node, ast.Constant):
        return isinstance(node.value, str)
    if isinstance(node, ast.JoinedStr):
        return True
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return _is_text(node.left) or _is_text(node.right)
    if isinstance(node, ast.IfExp):
        return _is_text(node.body) or _is_text(node.orelse)
    return False


def _text_parts(node: ast.AST) -> list[ast.AST]:
    if isinstance(node, ast.JoinedStr):
        return list(node.values)
    if isinstance(node, ast.BinOp):
        return [node.left, node.right]
    if isinstance(node, ast.IfExp):
        return [node.body, node.orelse]
    return []


def colons_introducing_a_command_or_path(source: str, name: str) -> list[str]:
    """Every whole message (printed, logged, raised, returned or a prompt), read after the terminal
    prefix. Help text and docstrings stay exempt by surface."""
    tree = ast.parse(source)
    skipped = _docstrings(tree) | _help_text(tree)
    texts = [node for node in ast.walk(tree) if _is_text(node)]
    parts = {id(part) for node in texts for part in _text_parts(node)}
    found = []
    for node in texts:
        if id(node) in parts or id(node) in skipped:
            continue
        for text in _messages(node):
            if COLON_INTRODUCING.search(after_prefix(text)):
                found.append(f"{name}:{node.lineno}: {text!r}")
    return found


def test_the_exemption_list_names_the_four_terminal_prefixes():
    assert TERMINAL_PREFIXES == ("Nebula:", "error:", "note:", "!")
    assert after_prefix("error: `codex` isn’t on PATH.") == " `codex` isn’t on PATH."
    assert after_prefix("Nebula: ignoring X.") == " ignoring X."
    assert after_prefix("Run: x") == "Run: x"


def test_person_read_terminal_lines_never_introduce_a_command_or_path_with_a_colon():
    found = []
    for name in PERSON_READ:
        found += colons_introducing_a_command_or_path((BACKEND / name).read_text(encoding="utf-8"), name)
    assert found == []


def test_the_colon_check_catches_what_it_is_for():
    check = colons_introducing_a_command_or_path
    # The old lines GM r59 and r60 reworded, as they were written.
    assert check("print((\"Stop the OpenClaw Gateway, then run: \" if c else \"Run: \") + \" \".join(argv))\n", "m.py")
    assert check("print(\"Run: \" + \" \".join(argv))\n", "m.py")
    assert check("x = f\" Backup: {backup}\" if r else f\" Backup, blanked out: {backup}\"\nprint(x)\n"
                 "print(f\"Wrote {path}.\" + f\" Backup: {backup}\")\n", "m.py")
    assert check("print(f\"error: `{argv[0]}` isn’t on PATH. Run this yourself once it is:\", file=sys.stderr)\n", "m.py")
    assert check("print(f\"Running: {_mask(setup['snippet'], token)}\")\n", "m.py")
    assert check("print(f\"# {setup['label']}: {setup['where']}\")\n", "m.py")
    # A colon ending a line introduces what comes next, as the old "Run this yourself once it is:" did.
    assert check("getpass.getpass(\"Token from Settings, hidden: \")\n", "m.py")
    # After a prefix, the rest is read: a colon introducing a command or a path is still caught.
    assert check("print(\"error: run this first: nebula mcp disconnect codex\")\n", "m.py")
    assert check("print(f\"note: the backup is here: {backup_path}\")\n", "m.py")
    assert check("print(\"Nebula: open it with: ~/bin/nebula\")\n", "m.py")
    assert check("log.warning(\"Person link unavailable. Start it with: backend/devserver.py --open\")\n", "m.py")
    assert check("log.warning(\"Person link unavailable. Pass it: --open\")\n", "m.py")
    assert check("raise MergeError(f\"Fix it: {path}\")\n", "m.py")
    # The prefix alone is exempt, a URL isn't a path, and a colon before words or a detail is fine.
    assert not check("print(f\"error: `{argv[0]}` isn’t on PATH. Add it to PATH, then run this command yourself.\")\n", "m.py")
    assert not check("print(f\"error: {exc}\")\nprint(f\"Nebula: open the canvas as you: {link}\")\n", "m.py")
    assert not check("print(\"Person link unavailable: no terminal.\")\nprint(f\"{path}: {exc}.\")\n", "m.py")
    assert not check("x = f\"http://{host}:{port}\"\nuvicorn.Config(\"main:app\")\n", "m.py")
    assert not check("print(\"Run this command.\")\nprint(\" \".join(argv))\n", "m.py")
    # Help text is exempt by surface here too, and so is a docstring.
    assert not check("p.add_argument('--url', help='Backend URL: $NEBULA_URL')\n", "m.py")
    assert not check('"""Run: nebula mcp connect"""\n', "m.py")
    # A returned or assigned message is read too, both ways of an `if`.
    assert check("def note(backup):\n    return f\" Backup: {backup}\" if r else \"\"\n", "m.py")
