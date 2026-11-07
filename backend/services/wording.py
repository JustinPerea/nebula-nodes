"""Counts in the agents' words (PR #199 round 17, GM r23 e): "1 node", "2
nodes", never "1 nodes". The one helper for every count the agent surfaces
print (`nebula context`, `nebula projects`, MCP, the notes and summaries)."""
from __future__ import annotations

# The words whose plural isn't the singular plus "s".
_PLURALS = {"canvas": "canvases", "copy": "copies", "entry": "entries", "proxy": "proxies"}


def plural(word: str, count: int) -> str:
    """``word`` for ``count`` of it: the singular for exactly 1."""
    if count == 1:
        return word
    return _PLURALS.get(word, f"{word}s")


def counted(count: int, word: str) -> str:
    """"1 node", "0 nodes", "3 projects", "2 canvases"."""
    return f"{count} {plural(word, count)}"
