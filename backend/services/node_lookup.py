"""Finding a node type from what an agent typed: its id, or its display name.

Agents name a node type the way the canvas shows it ("Moodboard") as often as
by id (`nebula-moodboard`). Lookups (`nebula info`/`describe`, MCP
`describe_node`) take either: an id always wins, and a display name counts
when exactly one node type has it, ignoring case and outer spaces. Writes
(edit_canvas, propose_change, `nebula apply`/`propose`/`create`/`quick`) take
ids only, since they store and bill by id and a display name can be renamed or
come to be shared; their refusal names the node the text was the name of
(`write_hint`).
"""
from __future__ import annotations

import difflib
from typing import Any, Mapping, NamedTuple

Definitions = Mapping[str, Mapping[str, Any]]


class Lookup(NamedTuple):
    """What `resolve` found. `definition_id` is None when nothing (or more than
    one node) matched; `note` is the one line to show when a name, not the id,
    picked it; `named` lists every node type the text names (two or more: the
    lookup refuses and lists them)."""

    definition_id: str | None
    note: str | None
    named: tuple[str, ...]


def _key(text: str) -> str:
    return text.strip().casefold()


def display_name(definitions: Definitions, definition_id: str) -> str:
    return str((definitions.get(definition_id) or {}).get("displayName") or definition_id)


def named(text: str, definitions: Definitions) -> tuple[str, ...]:
    """Ids of the node types the text names, other than by its exact id: the
    display name, or the id, equal to it ignoring case and outer spaces. Sorted."""
    key = _key(text)
    if not key:
        return ()
    return tuple(sorted(
        definition_id for definition_id, definition in definitions.items()
        if key in (definition_id.casefold(), _key(str(definition.get("displayName") or "")))
    ))


def resolve(text: str, definitions: Definitions) -> Lookup:
    """The node type `text` means, for a lookup. An exact id is that id; else
    the one node type whose display name (or id, ignoring case) it is."""
    if text in definitions:
        return Lookup(text, None, ())
    if text.strip() in definitions:
        return Lookup(text.strip(), None, ())
    matches = named(text, definitions)
    if len(matches) == 1:
        found = matches[0]
        return Lookup(found, f"{text.strip()} is the {display_name(definitions, found)} node: {found}", matches)
    return Lookup(None, None, matches)


def suggestions(text: str, definitions: Definitions, *, limit: int = 5) -> list[str]:
    """Candidate ids for text that isn't one: the node types it names first,
    then ids starting with it (a family name: `gpt-image-2` lists its four
    variants), else difflib close matches for a typo. [] when nothing is close."""
    first = list(named(text, definitions))
    query = text.strip()
    ids = list(definitions)
    prefix = sorted(nid for nid in ids if query and nid.startswith(query) and nid != query)
    rest = prefix or difflib.get_close_matches(query, ids, n=limit, cutoff=0.6)
    return first + [nid for nid in rest if nid not in first]


def shared_name_line(text: str, matches: tuple[str, ...], definitions: Definitions) -> str:
    """'2 node types are named Moodboard' for a name more than one node has."""
    names = {display_name(definitions, nid) for nid in matches}
    shown = names.pop() if len(names) == 1 else text.strip()
    return f"{len(matches)} node types are named {shown}"


def _either(items: list[str]) -> str:
    return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} or {items[-1]}"


def write_hint(text: str, definitions: Definitions) -> str:
    """What follows "unknown node definition 'x'" on a write: the node types
    the text is the name of, with their names ("did you mean nebula-moodboard
    (Moodboard)?"), else close ids, else nothing."""
    matches = list(named(text, definitions))
    if matches:
        return f": did you mean {_either([f'{nid} ({display_name(definitions, nid)})' for nid in matches])}?"
    close = suggestions(text, definitions)
    return f": did you mean {_either(close)}?" if close else ""


def unknown_definition(text: str, definitions: Definitions) -> str:
    """The write paths' refusal for a definition id that isn't one."""
    return f"unknown node definition '{text}'{write_hint(text, definitions)}"
