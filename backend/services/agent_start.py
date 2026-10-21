"""An agent's first call: GET /api/agent/start (plan v2.7, PR26, §5.10.1).

MCP `start_here` and `nebula context` both print this route, so the two ways
in can't drift. It is for the first turn, and again after a `gap` or `reset`
in wait_for_canvas_change. `look_at_canvas` stays the full snapshot for later
turns: folding node types and boards into it would make every later look pay
for them.

The answer has seven parts, in this order, each kept inside its own budget so
one big part (a 300-node canvas, 200 boards, every node type ready) never
crowds out the rest:

| Part        | Budget (tokens) |
|-------------|-----------------|
| `canvas`    | 2,500           |
| `pins`      | 400             |
| `proposals` | 300             |
| `boards`    | 800             |
| `nodes`     | 2,500           |
| `spend`     | 150             |
| `next`      | 300             |

Tokens are counted as characters / 4, of the JSON as `start_here` sends it
(`json.dumps`, no indent). The whole answer stays under 7,000 tokens (about
28,000 characters), below Claude Code's 10,000-token warning for a tool
result and its 50,000-character cut to a file. The budgets add up to 6,950,
so even every part at its budget leaves room for the answer's own keys.

`next` (and `boards.read` and `boards.use`) give the exact calls for a first build, with the
argument names each tool takes and the CLI's real flags (PR26b): the PR26
measurement's agents read `nebula apply --help` and `nebula info
nebula-moodboard`, or guessed `describe_node(id)`, because the hints named
the tools but not how to call them.

A part that doesn't fit is cut in a fixed way and says so (`truncated`,
counts) and where the rest is (`more`, in the words of the caller's way in:
MCP tool names, or `nebula` commands with `via=cli`).

Nothing private goes in: node params are redacted as the snapshot's are
(`safe_value`), boards carry no notes, image notes or private notes, and pins
carry no replies.
"""
from __future__ import annotations

import json
from typing import Any, Iterable, Mapping

from services import node_categories

CHARS_PER_TOKEN = 4
BUDGETS: dict[str, int] = {
    "canvas": 2500, "pins": 400, "proposals": 300, "boards": 800, "nodes": 2500, "spend": 150, "next": 300,
}
TOTAL_TOKENS = 7000

FULL_NODES = 60
NODE_PARAMS = 8
PARAM_CHARS = 60
NAME_CHARS = 60
MAX_AGENTS = 5
MAX_PINS = 10
PIN_CHARS = 140
MAX_PROPOSALS = 5
MAX_BOARDS = 30
DIRECTION_CHARS = 80
VIAS = ("mcp", "cli")
# Underscore params are the editor's bookkeeping, except who bills a run.
_SHOWN_INTERNAL = frozenset({"_provider", "_kreaAuth"})

# Every call names its arguments as the tool takes them, and every command
# its real flags (tests/test_first_turn_fixes.py checks both against the
# tools and the parser). `build` and `use` are plans the backend's own shape
# check accepts: text-input's param is `value` and its port `text`; the
# Moodboard node (nebula-moodboard) takes the board in its `moodboard` param
# and sends it from its `moodboard` port; Preview's input is `input`.
HINTS: dict[str, dict[str, str]] = {
    "mcp": {
        "canvas": "look_at_canvas gives every node",
        "pins": "look_at_canvas lists every open pin in full",
        "proposals": "look_at_canvas lists every open proposal",
        "boards": 'moodboard_list(project_id="<project-id>") lists a project\'s boards and Global\'s',
        "read": 'moodboard_get(board="<id or exact name>") gives one in full',
        "nodes": "find_nodes(category=…) gives the rest",
        "describe": 'describe_node(definition_id="<id>"): a node type\'s ports, params and prices, before you wire it.',
        "build": ('edit_canvas(note="...", nodes=[{"ref": "+p", "definitionId": "text-input", "params": '
                  '{"value": "a lake at dawn"}}, {"ref": "+g", "definitionId": "<id>"}], edges=[{"source": "+p", '
                  '"sourceHandle": "text", "target": "+g", "targetHandle": "prompt"}], arrange=true) adds and '
                  'wires in one call (idMap: the ids its +refs became); then run_nodes(node_id="n2").'),
        "propose": ('propose_change(note="...", nodes=..., edges=..., params=[{"nodeId": "n4", "params": {...}}], '
                    'run=["+g"]) takes the same nodes and edges, for a paid run over a limit or reworking their '
                    'graph: the person accepts in Nebula; get_proposal(proposal_id="...", wait_seconds=60) waits.'),
        "point": ('point_at(node_id="n2", say="...") points at what you work on; point_at(say="...") alone '
                  "shows the line where your cursor is."),
        "pin": ('resolve_pin(pin_id="...", reply="...") answers a pin once you\'ve acted on it; '
                "wait_for_canvas_change(since=<cursor>) waits for the next one."),
        "use": ('To show one: edit_canvas(nodes=[{"ref": "+mb", "definitionId": "nebula-moodboard", "params": '
                '{"moodboard": "<board id>"}}, {"ref": "+pv", "definitionId": "preview"}], edges=[{"source": "+mb", '
                '"sourceHandle": "moodboard", "target": "+pv", "targetHandle": "input"}]); to style a '
                'generator, wire "moodboard" to its "moodboard" input instead.'),
    },
    "cli": {
        "canvas": "`nebula look` gives every node",
        "pins": "`nebula pins` lists every pin in full",
        "proposals": "`nebula proposals` lists every open proposal",
        "boards": "`nebula moodboard list --project <project-id>` lists a project's boards and Global's",
        "read": "`nebula moodboard show <id>` gives one in full",
        "nodes": "`nebula nodes --category <category>` gives the rest",
        "describe": "`nebula info <id>`: a node type's ports, params and prices, before you wire or set it.",
        "build": ("`nebula apply --note \"...\" --add +p=text-input --param +p.value=\"a lake at dawn\" "
                  "--add +g=<id> --wire +p:text +g:prompt --arrange` adds and wires in one step and prints "
                  "the new ids; then `nebula run <node-id>`."),
        "propose": ("`nebula propose --note \"...\" --add +g=<id> --set nX.key=value --run +g` takes apply's "
                    "--add, --param and --wire too, for a paid run over a limit or reworking their graph; the "
                    "person accepts in Nebula."),
        "point": ("`nebula point n2 --say \"...\"` points at what you work on; `nebula point --say \"...\"` "
                  "alone shows the line where your cursor is."),
        "pin": ("Answer a pin with `nebula pin resolve <pin-id> --say \"...\"` once you've acted on it; "
                "`nebula watch --once --since <cursor> --journal <journal>` waits for the next one."),
        "use": ("To show one: `nebula apply --add +mb=nebula-moodboard --param +mb.moodboard=<board> "
                "--add +pv=preview --wire +mb:moodboard +pv:input`; to style a generator, wire +mb:moodboard "
                "to its moodboard input instead."),
    },
}
PRICES = ("USD per run at default settings: [low, high], \"free\", \"by input size\" (priced from the "
          "input file's size when it runs; the node's details give the rate), or null (no list price)")


def size(value: Any) -> int:
    """Characters of `value` as start_here sends it."""
    return len(json.dumps(value, ensure_ascii=False))


def tokens(value: Any) -> int:
    return -(-size(value) // CHARS_PER_TOKEN)


def _cut(text: Any, limit: int) -> str:
    flat = " ".join(str(text or "").split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def _short_value(value: Any) -> Any:
    if isinstance(value, bool) or value is None or isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        return _cut(value, PARAM_CHARS)
    return _cut(json.dumps(value, ensure_ascii=False), PARAM_CHARS)


def _filled(value: Any) -> bool:
    return value not in (None, "", [], {})


# -- canvas -----------------------------------------------------------------------

def _node_entry(node: Mapping[str, Any]) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": node.get("id"),
        "name": _cut(node.get("name"), NAME_CHARS),
        "definitionId": node.get("definitionId"),
        "state": node.get("state"),
    }
    if "onScreen" in node:
        entry["onScreen"] = node["onScreen"]
    if node.get("inputsFrom"):
        entry["inputsFrom"] = list(node["inputsFrom"])
    params = node.get("params") if isinstance(node.get("params"), Mapping) else {}
    shown = [(str(key), value) for key, value in params.items()
             if _filled(value) and (not str(key).startswith("_") or key in _SHOWN_INTERNAL)]
    if shown:
        entry["params"] = {key: _short_value(value) for key, value in shown[:NODE_PARAMS]}
        if len(shown) > NODE_PARAMS:
            entry["moreParams"] = len(shown) - NODE_PARAMS
    return entry


def canvas_part(snapshot: Mapping[str, Any], *, project: Mapping[str, Any] | None, caller_id: str | None,
                via: str) -> dict[str, Any]:
    """The project, whether a browser is watching, the selection, other
    agents' cursors, and the nodes: up to FULL_NODES in full (selected first,
    then on screen), then the rest by id and name, as the budget allows."""
    budget = BUDGETS["canvas"] * CHARS_PER_TOKEN
    selection = [str(node_id) for node_id in snapshot.get("selection") or []]
    agents = [
        {"name": agent.get("name"), "target": agent.get("target"), "secondsAgo": agent.get("secondsAgo")}
        for agent in snapshot.get("agents") or []
        if isinstance(agent, Mapping) and agent.get("id") != caller_id
    ][:MAX_AGENTS]
    nodes = [node for node in snapshot.get("nodes") or [] if isinstance(node, Mapping)]
    chosen = set(selection)
    ordered = ([node for node_id in selection for node in nodes if node.get("id") == node_id]
               + [node for node in nodes if node.get("id") not in chosen and node.get("onScreen") is True]
               + [node for node in nodes if node.get("id") not in chosen and node.get("onScreen") is not True])
    total = int(snapshot.get("nodeCount") or len(nodes))
    part: dict[str, Any] = {
        "project": dict(project) if project else None,
        "view": {"stale": bool((snapshot.get("view") or {}).get("stale", True))},
        "selection": selection,
        "agents": agents,
        "nodeCount": total,
        "nodes": [],
    }
    # Room for the closing fields, whether or not they end up there.
    used = size(part) + size({"others": {}, "truncated": True, "more": HINTS[via]["canvas"]})
    full: list[dict[str, Any]] = []
    others: dict[str, str] = {}
    for node in ordered:
        if not others and len(full) < FULL_NODES:
            entry = _node_entry(node)
            cost = size(entry) + 2
            if used + cost <= budget:
                full.append(entry)
                used += cost
                continue
        name = _cut(node.get("name"), NAME_CHARS)
        cost = size({str(node.get("id")): name}) + 2
        if used + cost > budget:
            break
        others[str(node.get("id"))] = name
        used += cost
    part["nodes"] = full
    if others:
        part["others"] = others
    if len(full) < total:
        part["truncated"] = True
        part["more"] = HINTS[via]["canvas"]
    return part


# -- pins and proposals -----------------------------------------------------------

def pins_part(pins: Iterable[Mapping[str, Any]], *, via: str) -> dict[str, Any]:
    """Open pins, newest first: id, text and anchor. Never a reply."""
    budget = BUDGETS["pins"] * CHARS_PER_TOKEN
    open_pins = sorted((pin for pin in pins if isinstance(pin, Mapping) and pin.get("status") == "open"),
                       key=lambda pin: str(pin.get("createdAt") or ""), reverse=True)
    part: dict[str, Any] = {"openCount": len(open_pins), "open": []}
    used = size(part) + size({"more": HINTS[via]["pins"]})
    cut = False
    for pin in open_pins[:MAX_PINS]:
        text = str(pin.get("text") or "")
        row = {"id": pin.get("id"), "text": _cut(text, PIN_CHARS), "anchor": pin.get("anchor")}
        cost = size(row) + 2
        if used + cost > budget:
            break
        cut = cut or row["text"] != " ".join(text.split())
        part["open"].append(row)
        used += cost
    if cut or len(part["open"]) < len(open_pins):
        part["more"] = HINTS[via]["pins"]
    return part


def proposals_part(briefs: Iterable[Mapping[str, Any]], *, via: str) -> dict[str, Any]:
    """Open proposals as canvas_proposals.brief gives them."""
    budget = BUDGETS["proposals"] * CHARS_PER_TOKEN
    rows = [dict(brief) for brief in briefs if isinstance(brief, Mapping)]
    part: dict[str, Any] = {"count": len(rows), "open": []}
    used = size(part) + size({"more": HINTS[via]["proposals"]})
    for row in rows[:MAX_PROPOSALS]:
        cost = size(row) + 2
        if used + cost > budget:
            break
        part["open"].append(row)
        used += cost
    if len(part["open"]) < len(rows):
        part["more"] = HINTS[via]["proposals"]
    return part


# -- boards -----------------------------------------------------------------------

def boards_part(summaries: Iterable[Mapping[str, Any]], *, active_project_id: str | None,
                project_names: Mapping[str, str], via: str) -> dict[str, Any]:
    """Every board in a live project or Global (MoodboardStore.summaries):
    the current project's first, then Global, then the others, each group
    newest edit first. A board whose project is in Recently deleted (or gone)
    is left out, as the app lists it nowhere."""
    budget = BUDGETS["boards"] * CHARS_PER_TOKEN
    rows: list[tuple[int, str, dict[str, Any]]] = []
    for board in summaries:
        project_id = board.get("projectId")
        if project_id is None:
            where, rank = "global", 1
        elif project_id == active_project_id:
            where, rank = "current", 0
        elif project_id in project_names:
            where, rank = _cut(project_names[project_id], NAME_CHARS), 2
        else:
            continue
        row: dict[str, Any] = {"id": board.get("id"), "name": _cut(board.get("name"), NAME_CHARS), "where": where,
                               "images": int(board.get("images") or 0), "analyzed": bool(board.get("analyzed"))}
        if board.get("direction"):
            row["direction"] = _cut(board["direction"], DIRECTION_CHARS)
        rows.append((rank, str(board.get("updatedAt") or ""), row))
    # Newest first inside each group; Python's sort is stable, so sort twice.
    rows.sort(key=lambda item: item[1], reverse=True)
    rows.sort(key=lambda item: item[0])
    part: dict[str, Any] = {"count": len(rows), "rows": []}
    if rows:
        # How to read one, and how to put one on the canvas, so a first build
        # needn't guess moodboard_get's argument or describe the Moodboard node.
        part["read"] = HINTS[via]["read"]
        part["use"] = HINTS[via]["use"]
    used = size(part) + size({"truncated": True, "more": HINTS[via]["boards"]})
    for _rank, _updated, row in rows[:MAX_BOARDS]:
        cost = size(row) + 2
        if used + cost > budget:
            break
        part["rows"].append(row)
        used += cost
    if len(part["rows"]) < len(rows):
        part["truncated"] = True
        part["more"] = HINTS[via]["boards"]
    # A Direction cut short is in full in `read`'s answer.
    return part


# -- node types -------------------------------------------------------------------

def nodes_part(rows: Iterable[Mapping[str, Any]], *, total: int, notes: Iterable[str] = (), krea: str | None = None,
               via: str) -> dict[str, Any]:
    """The node types that run here, by category: id -> price. `runsWith`
    names the ones that run other than with a key (the Krea plan, a Nous
    sign-in, or free while priced otherwise). Categories go in
    node_categories.ORDER; past the budget the rest are counted in `rest`."""
    budget = BUDGETS["nodes"] * CHARS_PER_TOKEN
    ready = [row for row in rows if isinstance(row, Mapping) and row.get("runsWith")]
    by_category: dict[str, list[Mapping[str, Any]]] = {}
    for row in ready:
        by_category.setdefault(str(row.get("category") or "other"), []).append(row)
    part: dict[str, Any] = {"ready": len(ready), "total": total, "prices": PRICES}
    if krea:
        part["krea"] = krea
    note_list = [note for note in notes if note]
    if note_list:
        part["notes"] = note_list
    part["byCategory"] = {}
    used = size(part) + size({"runsWith": {}, "truncated": True, "rest": {}, "more": HINTS[via]["nodes"]})
    runs_with: dict[str, list[str]] = {}
    rest: dict[str, int] = {}
    full = True
    for category in node_categories.ordered(by_category):
        members = sorted(by_category[category], key=lambda row: str(row.get("id")))
        shown: dict[str, Any] = {}
        for index, row in enumerate(members):
            node_id = str(row.get("id"))
            access = row.get("runsWith")
            unusual = access not in ("key", None) and not (access == "free" and row.get("price") == "free")
            cost = size({node_id: row.get("price")}) + 2 + (size(node_id) + 2 if unusual else 0)
            cost += (size({category: {}}) + 2) if not shown else 0
            cost += (size({access: []}) + 2) if unusual and access not in runs_with else 0
            if not full or used + cost > budget:
                full = False
                rest[category] = len(members) - index
                break
            shown[node_id] = row.get("price")
            used += cost
            if unusual:
                runs_with.setdefault(str(access), []).append(node_id)
        if shown:
            part["byCategory"][category] = shown
        elif category not in rest:
            rest[category] = len(members)
    if runs_with:
        part["runsWith"] = runs_with
    if rest:
        part["truncated"] = True
        part["rest"] = rest
        part["more"] = HINTS[via]["nodes"]
    return part


# -- spend and next ------------------------------------------------------------------

def spend_part(spend: Mapping[str, Any]) -> dict[str, Any]:
    """GET /api/agent/spend, short: the per-run limit, this budget's kind,
    its limit and use, and Krea plan runs used and allowed.

    Use is counted the way a run is checked (agent_spend.session_budgets): an
    in-app chat against its own session; every outside agent against the
    shared 24-hour budget, which an app's and a personal agent's runs count
    in too (`outsideSpent`); an app also against its own daily line, so it
    gets both. Krea plan runs count in the shared budget for outside agents."""
    limits = spend.get("limits") or {}
    if not spend.get("limited"):
        return {"limited": False, "perRunUsd": limits.get("perRunUsd")}
    budget = spend.get("budget")
    own = spend.get("spent") or {}
    outside = spend.get("outsideSpent") or own
    part: dict[str, Any] = {"budget": budget, "perRunUsd": limits.get("perRunUsd")}
    if budget == "chat":
        part.update(limitUsd=limits.get("sessionUsd"), usedUsd=own.get("totalUsd"))
        plan = own
    elif budget == "app":
        part.update(limitUsd=limits.get("appDailyUsd"), usedUsd=own.get("totalUsd"),
                    sharedLimitUsd=limits.get("outsideDailyUsd"), sharedUsedUsd=outside.get("totalUsd"))
        plan = outside
    else:
        part.update(limitUsd=limits.get("outsideDailyUsd"), usedUsd=outside.get("totalUsd"))
        plan = outside
    if spend.get("window"):
        part["window"] = spend["window"]
    part["kreaPlanRuns"] = {"used": plan.get("kreaPlanRuns"), "limit": limits.get("kreaPlanRuns")}
    if limits.get("models"):
        part["modelLimits"] = len(limits["models"])
    return part


def next_part(events: Mapping[str, Any], *, via: str) -> dict[str, Any]:
    """The events cursor, then one line per first-turn call: describe a node,
    build, propose, point (with or without a target) and answer a pin."""
    hints = HINTS[via]
    return {"events": {"cursor": events.get("cursor"), "journal": events.get("journal")},
            "describe": hints["describe"], "build": hints["build"], "propose": hints["propose"],
            "point": hints["point"], "pins": hints["pin"]}


def build(**parts: dict[str, Any]) -> dict[str, Any]:
    """The answer, its parts in the documented order."""
    return {name: parts[name] for name in BUDGETS}
