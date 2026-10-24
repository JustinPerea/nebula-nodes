"""A project's size, the one way Nebula measures it (Q118).

"Project size" is exactly the bytes the save check counts
(main._stage_project_snapshot): the snapshot as ``json.dumps(snapshot,
allow_nan=False, ensure_ascii=False)`` writes it (Python's default
separators, ", " and ": "), in UTF-8. The canvas measures the snapshot it is
about to send the same way (frontend/src/lib/projectSize.ts), and
tests/fixtures/project_size_cases.json pins both to the same numbers.

``breakdown`` says what takes the space, largest first: one row per node
(its whole entry in the snapshot), named by the part that takes most of it,
then the project's own parts. The canvas's "what's large" panel and the
agents' project_size tool (GET /api/projects/{id}/size) both list these
rows; the panel computes them from the tab's own snapshot (a paused tab's
edits aren't on the backend yet), this module from the backend's view of the
project. Every byte is in a row.

Parts of a node (the fields they cover):
- "text": ``data.params``, the node's settings: prompts, notes, every value
  the person typed or set, except files pasted into them as data: URLs;
- "embedded": the ``data:`` URL strings inside ``data.params`` (a painted
  mask, say), counted as the JSON string each one is;
- "outputs": ``data.outputs``, plus ``data.batchOutputs`` and
  ``data.batchVariants`` (a batch's kept results);
- "node": the rest of the entry (id, type, position, name, model, run state,
  ports, the last error, run notes).
A tie goes to the earlier part in that list.

Rows that aren't nodes: "runHistory" (the Run History panel's records, which
stay when a node is deleted), "wires" (every connection), "createDraft"
(Create's unsent draft) and "project" (what is left: the view, the session
id, the keys and separators between the parts).
"""
from __future__ import annotations

import json
import math
from typing import Any

MIB = 1024 * 1024
TOP_ROWS = 10
PARTS = ("text", "outputs", "embedded", "node")
PART_LABELS = {"text": "Text", "outputs": "Stored outputs", "embedded": "Embedded files", "node": "Node data"}
ROW_NAMES = {"runHistory": "Run history", "wires": "Wires", "createDraft": "Create draft", "project": "Project settings"}
_STORED_OUTPUTS = ("outputs", "batchOutputs", "batchVariants")


def json_bytes(value: Any) -> int:
    """The bytes the save check counts for ``value``."""
    return len(json.dumps(value, allow_nan=False, ensure_ascii=False).encode("utf-8"))


def snapshot_bytes(snapshot: Any) -> int:
    """A project's size: its snapshot as the save check measures it."""
    return json_bytes(snapshot)


def _data_url_bytes(value: Any) -> int:
    total = 0
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, str):
            if current.startswith("data:"):
                total += json_bytes(current)
        elif isinstance(current, dict):
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
    return total


def node_parts(node: dict[str, Any]) -> tuple[int, dict[str, int]]:
    """A node entry's bytes and how they split between its parts."""
    total = json_bytes(node)
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    params = data.get("params")
    embedded = _data_url_bytes(params) if params is not None else 0
    text = json_bytes(params) - embedded if params is not None else 0
    outputs = sum(json_bytes(data[key]) for key in _STORED_OUTPUTS if key in data)
    return total, {"text": text, "outputs": outputs, "embedded": embedded, "node": total - text - outputs - embedded}


def _largest_part(parts: dict[str, int]) -> str:
    return max(PARTS, key=lambda part: (parts[part], -PARTS.index(part)))


def breakdown(snapshot: dict[str, Any]) -> dict[str, Any]:
    """``{"bytes", "rows"}``: the project's size and every row, largest first
    (ties keep the snapshot's order). A node row: ``{"kind": "node", "nodeId",
    "definitionId", "label", "part", "bytes"}``; the others ``{"kind",
    "bytes"}`` with a ``count`` for run history and wires."""
    total = snapshot_bytes(snapshot)
    rows: list[dict[str, Any]] = []
    for node in snapshot.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        size, parts = node_parts(node)
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        rows.append({"kind": "node", "nodeId": node.get("id"), "definitionId": data.get("definitionId"),
                     "label": data.get("label"), "part": _largest_part(parts), "bytes": size})
    history = snapshot.get("runHistory")
    if isinstance(history, list) and history:
        rows.append({"kind": "runHistory", "count": len(history), "bytes": json_bytes(history)})
    edges = snapshot.get("edges")
    if isinstance(edges, list) and edges:
        rows.append({"kind": "wires", "count": len(edges), "bytes": json_bytes(edges)})
    if snapshot.get("createDraft") is not None:
        rows.append({"kind": "createDraft", "bytes": json_bytes(snapshot["createDraft"])})
    rows.append({"kind": "project", "bytes": total - sum(row["bytes"] for row in rows)})
    rows.sort(key=lambda row: -row["bytes"])
    return {"bytes": total, "rows": rows}


def megabytes(size: int, limit: int) -> str:
    """A size as the canvas shows it (frontend lib/projectSize.ts
    displaySize): MiB labelled "MB", one decimal, rounded up while over the
    limit (so it never reads as the limit or under) and down at or under it."""
    tenths = size / MIB * 10
    shown = math.ceil(tenths) if size > limit else math.floor(tenths)
    return f"{shown / 10:.1f} MB"


def listed_count(rows: list[dict[str, Any]]) -> int:
    """How many of the rows (largest first) are listed: those of 0.1 MiB and
    up, at most TOP_ROWS; the rest go in "smaller" (frontend lib/projectSize.ts
    listedRowCount; GM - Design, #182: "Rows under 0.1 MB: don't show them.")."""
    count = 0
    while count < len(rows) and count < TOP_ROWS and rows[count]["bytes"] * 10 >= MIB:
        count += 1
    return count


def row_size(size: int) -> str:
    """A row's size as the canvas panel shows it (frontend lib/projectSize.ts
    rowSize): MiB to the nearest tenth, halves up like Math.round (Python's
    round() would send halves to even)."""
    return f"{math.floor(size / MIB * 10 + 0.5) / 10:.1f} MB"


def over_by(size: int, limit: int) -> str:
    """How much smaller it must get, in MB, rounded up so it never reads 0.0
    while still over."""
    return f"{math.ceil(max(0, size - limit) / MIB * 10) / 10:.1f} MB"


def limit_text(limit: int) -> str:
    """The limit as GM writes it: "16 MB"."""
    whole = limit / MIB
    return f"{whole:g} MB" if whole >= 1 else f"{limit:,} bytes"
