"""A node's name as Nebula shows it to a person or an agent, in curly quotes
as the Agents panel shows it (GM - Design, 2026-10-25: Connecting “A” to “B”).
The cursor bubbles (main._quoted), `nebula delete` and the spending check's
refusals use it."""
from __future__ import annotations

_QUOTES = "“”\""


def quoted(label: str) -> str:
    """“label”, without doubling quotes a person typed around the name
    themselves (a node named “Hero” or "Hero" shows as “Hero”, not ““Hero””).

    Only one pair comes off, and only a pair: the name starts and ends with a
    quote, something is left inside, and no quote is left inside (so `"A" and
    "B"` keeps all its quotes). An unpaired quote stays: `12"` is “12"”, and a
    name that is only quotes keeps them."""
    text = label.strip()
    inner = text[1:-1].strip()
    if len(text) >= 2 and text[0] in _QUOTES and text[-1] in _QUOTES and inner \
            and not any(mark in inner for mark in _QUOTES):
        text = inner
    return f"“{text}”"


def _joined(parts: list[str]) -> str:
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + f" and {parts[-1]}" if parts else ""


def node_name_list(names: list[str]) -> str:
    """Nodes by name in a line, the shared name-list helper's rule (frontend
    lib/errorCopy.ts nodeNameList, the same cases): up to 3 by name,
    "“A”", "“A” and “B”", "“A”, “B” and “C”", a repeated name counted ("2
    “Writer” nodes"); from 4, a count ("4 nodes")."""
    if len(names) >= 4:
        return f"{len(names)} nodes"
    groups: dict[str, int] = {}
    for name in names:
        groups[name] = groups.get(name, 0) + 1
    return _joined([f"\u201c{name}\u201d" if count == 1 else f"{count} \u201c{name}\u201d nodes"
                    for name, count in groups.items()])
