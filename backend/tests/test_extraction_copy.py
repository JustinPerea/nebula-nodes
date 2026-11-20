"""The extraction package's messages use Nebula's curly apostrophe (U+2019), as the page shows them.

Docstrings and comments are not messages, so they are skipped.
"""
from __future__ import annotations

import io
import re
import tokenize
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1] / "extraction"
STRAIGHT = re.compile(r"(?<=[A-Za-z])'(?=[A-Za-z])")
TEXT = {tokenize.STRING} | ({tokenize.FSTRING_MIDDLE} if hasattr(tokenize, "FSTRING_MIDDLE") else set())
SKIP = (tokenize.NL, tokenize.COMMENT)


def straight_apostrophes(source: str) -> list[tuple[int, str]]:
    """(line, literal) for each string literal, docstrings aside, with a straight letter-apostrophe-letter."""
    tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    found = []
    for i, token in enumerate(tokens):
        if token.type not in TEXT or not STRAIGHT.search(token.string):
            continue
        if token.type == tokenize.STRING:
            before = i - 1
            while before >= 0 and tokens[before].type in SKIP:
                before -= 1
            after = i + 1
            while after < len(tokens) and tokens[after].type in SKIP:
                after += 1
            starts = before < 0 or tokens[before].type in (tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
            if starts and tokens[after].type in (tokenize.NEWLINE, tokenize.ENDMARKER):
                continue  # a docstring
        found.append((token.start[0], token.string))
    return found


def test_the_package_messages_use_the_curly_apostrophe():
    files = sorted(PACKAGE.glob("*.py"))
    assert any(path.name == "store.py" for path in files)
    offenders = [f"{path.name}:{line} {text}" for path in files
                 for line, text in straight_apostrophes(path.read_text(encoding="utf-8"))]
    assert offenders == []


def test_the_scan_catches_a_message_and_skips_a_docstring():
    source = '"""It doesn\'t count."""\n\ndef f():\n    """Nor this one\'s."""\n    raise ValueError("That isn\'t curly.")\n'
    assert [line for line, _ in straight_apostrophes(source)] == [5]
    assert straight_apostrophes('x = f"{a} can\'t {b}"\n') != []
    assert straight_apostrophes('x = "can’t"\n') == []
