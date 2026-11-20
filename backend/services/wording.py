"""Counts in the agents' words (PR #199 round 17, GM r23 e): "1 node", "2
nodes", never "1 nodes". The one helper for every count the agent surfaces
print (`nebula context`, `nebula projects`, MCP, the notes and summaries)."""
from __future__ import annotations

import json
from typing import Any

from services.text_cut import clean_name

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


# A run output longer than this prints as a one-line summary unless --verbose
# (design: a 51 KB moodboard bundle in a terminal or an agent’s tool result
# lands in an agent’s context). Strings, dicts and lists share the limit; a
# dict or list counts its JSON.
RUN_VALUE_TEXT_LIMIT = 200


def _value_kind(port_type: Any, value: Any) -> str:
    """A short kind for a collapsed output: the port’s type or the value’s shape."""
    label = str(port_type or "")
    if label == "Moodboard":
        return "moodboard bundle"
    if isinstance(value, list):
        return f"list of {len(value)}"
    if isinstance(value, dict):
        return f"{label.lower()} object" if label and label != "Any" else "object"
    return "text"


def collapsed_summary(port_type: Any, value: Any) -> str | None:
    """“moodboard bundle, 51 KB” for a run output that collapses (a dict, a list
    or a string or the JSON of one over 200 characters), else None: it prints whole. Bytes under
    1 KB, else KB."""
    if isinstance(value, str):
        if len(value) <= RUN_VALUE_TEXT_LIMIT:
            return None
        size = len(value.encode("utf-8"))
    elif isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False)
        if len(text) <= RUN_VALUE_TEXT_LIMIT:
            return None
        size = len(text.encode("utf-8"))
    else:
        return None
    kind = _value_kind(port_type, value)
    return f"{kind}, {size} bytes" if size < 1024 else f"{kind}, {round(size / 1024)} KB"


def port_words(label: Any, port_id: str) -> str:
    """A port’s name in a sentence: its label from the node definition, lower-cased
    by the rule canvas_undo._noun uses (“Images” gives “images”; “Image URLs” and a
    provider name keep their capitals), else its id in words (“image_urls”)."""
    from services.canvas_undo import _noun  # design: one rule for a label as a noun

    return (_noun(str(label)) if isinstance(label, str) and label.strip() else "") or \
        port_id.replace("_", " ").replace("-", " ").strip() or port_id


def collapsed_owner(name: str, port: str | None) -> str:
    """“Preview” for a node with one port of results, “Preview”’s images with more."""
    shown = clean_name(name) or "?"  # a label is free text: a newline mustn’t split the one-line summary
    return f"“{shown}”’s {port}" if port else f"“{shown}”"
