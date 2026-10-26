from __future__ import annotations

import json
from typing import Any

# The readiness rule lives with the backend so the CLI and MCP server agree.
from services.node_readiness import node_access  # noqa: F401 (re-exported for tests and callers)
from services.agent_params import ASSET_PARAM_TYPES
from services.canvas_undo import UNDONE_VERBS, nothing_went_back
from services.maker_sizes import rule_note
from services import node_categories
from services.node_route import all_param_definitions, route_hides, route_param_definitions


_CATEGORY_HEADINGS = {
    "image-gen": "IMAGE GENERATION",
    "video-gen": "VIDEO GENERATION",
    "text-gen": "TEXT / CHAT",
    "audio-gen": "AUDIO",
    "3d-gen": "3D GENERATION",
    "transform": "TRANSFORM",
    "analyzer": "ANALYZER",
    "utility": "UTILITY",
    "universal": "UNIVERSAL",
}


def agent_node_price(value: Any) -> str:
    """A GET /api/agent/nodes `price` ("free", {"usd": [low, high]}, null) as
    `nebula context` prints prices: free, $0.04, $0.01–0.25, no list price."""
    if isinstance(value, dict):
        value = value.get("usd")
    return _price(value)


def format_agent_nodes(rows: list[dict[str, Any]], *, ranked: bool,
                       counts: dict[str, tuple[int, int]] | None = None) -> str:
    """`nebula nodes`: GET /api/agent/nodes rows as a table by category.

    A row that runs here shows how (key, free, krea, nous) and its list price
    at default settings; one that doesn't shows what it's `missing`. Rows keep
    the route's order inside a category (ready first, then best matches).
    `ranked` (a word search) lists categories in the order their best match
    comes, so the first row is the route's first; otherwise in
    node_categories.ORDER. `counts` is category -> (run here, match) for
    the heading."""
    by_cat: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_cat.setdefault(str(row.get("category") or "other"), []).append(row)
    order = list(by_cat) if ranked else node_categories.ordered(by_cat)
    id_width = max([len(str(row.get("id"))) for row in rows] + [20])
    name_width = min(max([len(str(row.get("name") or "")) for row in rows] + [12]), 32)

    lines: list[str] = []
    for category in order:
        members = by_cat[category]
        heading = _CATEGORY_HEADINGS.get(category, category.upper())
        ready, matched = (counts or {}).get(category, (sum(1 for row in members if row.get("runsWith")),
                                                       len(members)))
        lines.append(f"{heading} ({ready} of {matched} run here)" if ready != matched
                     else f"{heading} ({matched})")
        for row in members:
            head = f"  {str(row.get('id')):<{id_width}}  {str(row.get('name') or ''):<{name_width}}"
            if row.get("runsWith"):
                line = f"{head}  {str(row['runsWith']):<5} {agent_node_price(row.get('price'))}"
                if row.get("needsKeyFor"):
                    line += f"  (at its defaults; {_cli_words(str(row['needsKeyFor']))})"
            else:
                line = f"{head}  {row.get('missing') or 'needs setup'}"
            lines.append(line.rstrip())
        lines.append("")
    return "\n".join(lines).rstrip("\n")


def _cli_words(text: str) -> str:
    """An agent route's MCP words in `nebula` words (main._cli_words)."""
    return text.replace("describe_node", "`nebula info <id>`")


def _route_takes(node: dict[str, Any], route: dict[str, Any]) -> str:
    """What one route of a route-table node takes that differs from the
    PARAMS list (all_param_definitions): its own params, and the shared
    params it narrows (route_param_definitions), e.g. "resolution
    768sq|1k|2k|4k; grounding"."""
    union = {str(p.get("key")): p for p in all_param_definitions(node)}
    parts: list[str] = []
    for param in route_param_definitions(node, str(route.get("id"))):
        key = str(param.get("key"))
        if key.startswith("_") or param.get("hidden"):
            continue
        whole = union.get(key) or {}
        if param.get("options") != whole.get("options"):
            parts.append(f"{key} " + "|".join(str(o.get("value") if isinstance(o, dict) else o)
                                               for o in param.get("options") or []))
        elif (param.get("min"), param.get("max")) != (whole.get("min"), whole.get("max")):
            parts.append(f"{key} {param.get('min', '')}-{param.get('max', '')}")
        elif not any(key == str(p.get("key")) for p in node.get("sharedParams") or []):
            parts.append(key)
    return "; ".join(parts)


def format_node_detail(node: dict[str, Any]) -> str:
    """Format full detail for a single node (nebula info output)."""
    lines: list[str] = []
    name = node.get("displayName", node["id"])
    lines.append(f"{name} ({node['id']})")

    provider = node.get("apiProvider", "?")
    key = node.get("envKeyName", "?")
    if isinstance(key, list):
        key = " or ".join(key)
    pattern = node.get("executionPattern", "?")
    lines.append(f"Provider: {provider} | Key: {key} | Exec: {pattern}")
    routes = node.get("routes") if isinstance(node.get("routes"), list) else []
    if routes:
        # A route-table node (services/node_route.py): one line per provider
        # route, in Auto order, and how to pick one.
        lines.append("ROUTES (_provider; auto takes the first with its key set):")
        for route in routes:
            keys = " or ".join(str(k) for k in route.get("keys") or []) or "-"
            tags = [tag for tag in ("maker" if route.get("maker") else "",
                                    f"Krea plan {route['plan']}" if route.get("plan") else "") if tag]
            lines.append(f"  {str(route.get('id')):<16}{str(route.get('provider')):<14}{keys}"
                         + (f"  ({', '.join(tags)})" if tags else ""))
            takes = _route_takes(node, route)
            if takes:
                lines.append(f"  {'':<16}takes {takes}")
            # What this provider doesn't offer, one line: "no Seed".
            hides = route_hides(node, str(route.get("id")))
            if hides:
                lines.append(f"  {'':<16}{'; '.join(hides)}")
        lines.append("  Changing _provider is the person's call: `nebula propose` it; direct edits are refused.")
    lines.append("")

    inputs = node.get("inputPorts", [])
    if inputs:
        lines.append("INPUTS:")
        for p in inputs:
            req = "required" if p.get("required") else "optional"
            lines.append(f"  {p['id']:<16}{p['dataType']:<10}{req}")
        lines.append("")

    outputs = node.get("outputPorts", [])
    if outputs:
        lines.append("OUTPUTS:")
        for p in outputs:
            # A gate output is withheld on some runs; nodes wired to it are then skipped.
            gate = "gate" if p.get("conditional") else ""
            lines.append(f"  {p['id']:<16}{p['dataType']:<10}{gate}".rstrip())
        lines.append("")

    params = node.get("params", [])
    if routes:
        # Shared params and each route's own (services/node_route.py), once each.
        params = all_param_definitions(node)
    if params:
        lines.append("PARAMS:")
        for p in params:
            default = p.get("default", "")
            ptype = p.get("type", "")
            detail = f"{p['key']:<20}{ptype:<10}{default}"
            opts = p.get("options", [])
            if opts:
                # Show values (what `nebula set` accepts), not labels (UI display strings).
                # If label differs from value, annotate as "value (label)" so both are visible.
                parts = []
                for o in opts:
                    val = o.get("value", "")
                    lbl = o.get("label", "")
                    part = f"{val} ({lbl})" if lbl and lbl != val else str(val)
                    only = o.get("visibleWhen")
                    if only:
                        part += f" {{{_option_condition(only, p.get('visibleWhen') or {})}}}"
                    parts.append(part)
                detail += f"  [{', '.join(parts)}]"
            if p.get("min") is not None or p.get("max") is not None:
                lo = p.get("min", "")
                hi = p.get("max", "")
                detail += f"  min={lo} max={hi}"
            for controller, table in (p.get("defaultBy") or {}).items():
                # Grouped by value, every entry listed: an agent needs to know
                # which models leave the default.
                by_value: dict[str, list[str]] = {}
                for v, d in table.items():
                    by_value.setdefault(str(d), []).append(str(v))
                listed = "; ".join(f"{d} for {', '.join(vs)}" for d, vs in by_value.items())
                detail += f"  (default by {controller}: {listed})"
            vis = p.get("visibleWhen")
            if vis:
                conds = [f"{k}={v}" for k, vals in vis.items() for v in vals]
                detail += f"  (when {', '.join(conds[:3])})"
            source = ASSET_PARAM_TYPES.get(str(ptype))
            if source:
                detail += f"  (a {source['noun']} id; {source['list']} lists them)"
            lines.append(f"  {detail}")
        lines.append("")

    size_note = rule_note(node)
    if size_note:
        lines.append(f"SIZE: {size_note}")
        lines.append("")

    board = node.get("moodboardAdapter")
    if isinstance(board, dict):
        lines.extend(_moodboard_lines(board))
        lines.append("")

    return "\n".join(lines)


def _moodboard_lines(board: dict[str, Any]) -> list[str]:
    """What a wired moodboard does here (describe_node's moodboardAdapter):
    the card's line, then the channel, weight, ports it skips and the params
    or routes that change it, on one line."""
    route = f" (on {board['route']})" if board.get("route") else ""
    lines = [f"MOODBOARD: {board.get('line')}{route}"]
    parts = [str(board.get("channel") or board.get("note") or "")]
    weight = board.get("weight") if isinstance(board.get("weight"), dict) else None
    if weight:
        span = weight.get("range")
        parts.append(" ".join(str(bit) for bit in (
            "weight", weight.get("mode"), weight.get("field") or weight.get("param"),
            f"{span[0]}-{span[1]}" if isinstance(span, list) and len(span) == 2 else None) if bit))
    if board.get("needsWired"):
        parts.append(f"needs {', '.join(board['needsWired'])} wired")
    if board.get("never"):
        parts.append(f"never {', '.join(board['never'])}")
    for variant in board.get("variants") or []:
        when = ", ".join(f"{key}={value}" for key, value in (variant.get("when") or {}).items())
        slots = variant.get("slots")
        said = (f"up to {slots[0].get('max')}" if isinstance(slots, list) and slots and variant.get("line") == board.get("line")
                else variant.get("line"))
        parts.append(f"{when}: {said}")
    parts = [part for part in parts if part]
    if parts:
        lines.append("  " + " · ".join(parts))
    return lines


def _option_condition(only: dict[str, list[Any]], param_when: dict[str, list[Any]]) -> str:
    """When an option is offered: "not for model=a|b" when that is the shorter
    way to say it against the param's own visibleWhen (claude-chat effort
    xhigh isn't offered for Opus 4.6 / Sonnet 4.6), else "only model=a|b"."""
    conds = []
    for key, values in only.items():
        allowed = [str(v) for v in values]
        scope = [str(v) for v in param_when.get(key) or []]
        excluded = [v for v in scope if v not in allowed]
        if scope and set(allowed) <= set(scope) and len(excluded) < len(allowed):
            conds.append(f"not for {key}={'|'.join(excluded)}")
        else:
            conds.append(f"only {key}={'|'.join(allowed)}")
    return "; ".join(conds)


def format_keys(settings: dict[str, Any], nodes: list[dict[str, Any]]) -> str:
    """Format which provider keys are set (nebula keys output).

    `settings` is MCP get_settings' view (project_client.get_settings):
    `configured` maps each key's name to true or false, so there is no part
    of a key here to print."""
    configured_map = settings.get("configured") if isinstance(settings.get("configured"), dict) else {}

    key_to_nodes: dict[str, list[str]] = {}
    all_keys: set[str] = {str(name) for name in configured_map}
    for n in nodes:
        env = n.get("envKeyName", "")
        keys_list = env if isinstance(env, list) else [env] if env else []
        for k in keys_list:
            all_keys.add(k)
            key_to_nodes.setdefault(k, []).append(n.get("displayName", n["id"]))

    configured: list[str] = []
    missing: list[str] = []

    for key_name in sorted(all_keys):
        node_names = key_to_nodes.get(key_name, [])
        count = len(node_names)
        preview = ", ".join(node_names[:3])
        if len(node_names) > 3:
            preview += ", ..."
        uses = f"{count} nodes ({preview})" if count else "no node uses it"
        if configured_map.get(key_name) is True:
            configured.append(f"  {key_name:<25}{'set':<10}{uses}")
        else:
            missing.append(f"  {key_name:<25}{'':10}{count} nodes unavailable")

    lines: list[str] = []
    if configured:
        lines.append("CONFIGURED KEYS:")
        lines.extend(configured)
        lines.append("")
    if missing:
        lines.append("NOT CONFIGURED:")
        lines.extend(missing)
        lines.append("")

    shown = []
    if settings.get("executionMode"):
        shown.append(f"execution mode {settings['executionMode']}")
    if settings.get("batchSizeCap") is not None:
        shown.append(f"batch cap {settings['batchSizeCap']}")
    if settings.get("kreaConnectionMode"):
        shown.append(f"Krea via {settings['kreaConnectionMode']}")
    if settings.get("exportFolder"):
        shown.append(f"exports to {settings['exportFolder']}")
    routing = settings.get("routing") or {}
    if routing:
        shown.append("routing " + ", ".join(f"{node} → {choice}" for node, choice in sorted(routing.items())))
    if shown:
        lines.append(f"SETTINGS: {'; '.join(shown)}")
    lines.append("Set or not set only: the CLI has no person token, so it never shows any part of a key. "
                 "`nebula providers` checks that they work.")
    return "\n".join(lines)


def format_providers(status: dict[str, Any]) -> str:
    """Format MCP provider_status' view (nebula providers output)."""
    providers = status.get("providers") or {}
    lines = ["PROVIDERS (free, read-only checks, kept 5 minutes; --refresh checks again):"]
    if not providers:
        lines.append("  (none reported)")
    width = max([len(str(name)) for name in providers] + [8]) + 2
    for name, row in providers.items():
        if not isinstance(row, dict):
            continue
        checked = str(row.get("lastChecked") or "")[:16].replace("T", " ")
        when = f"checked {checked}" if checked and row.get("status") != "not_configured" else ""
        detail = f"  {row['detail']}" if row.get("detail") else ""
        lines.append(f"  {str(name):<{width}}{str(row.get('status') or '?'):<22}{when}{detail}".rstrip())
    krea = status.get("krea") or {}
    if krea:
        pending = " (sign-in waiting for the person, in Settings)" if krea.get("signInPending") else ""
        error = f": {krea['error']}" if krea.get("error") else ""
        lines.append("")
        lines.append(f"Krea account: {krea.get('status') or 'unknown'}{pending}{error}")
    return "\n".join(lines)


def format_graph(state: dict[str, Any], node_defs: dict[str, dict[str, Any]] | None = None) -> str:
    """Format current graph state (nebula graph output)."""
    nodes = state.get("nodes", [])
    edges = state.get("edges", [])

    if not nodes:
        return "Graph is empty."

    lines: list[str] = []
    lines.append("NODES:")
    for n in nodes:
        nid = n["id"]
        defn = node_defs.get(n["definitionId"], {}) if node_defs else {}
        name = defn.get("displayName", n["definitionId"])
        params_str = "  ".join(f"{k}={v}" for k, v in n.get("params", {}).items())
        outputs = n.get("outputs", {})
        status = ""
        if outputs:
            first_out = next(iter(outputs.values()), {})
            val = first_out.get("value", "") if isinstance(first_out, dict) else ""
            if val:
                status = f" -> {val}"
        lines.append(f"  {nid:<6}{name:<25}{params_str}{status}")

    if edges:
        lines.append("")
        lines.append("CONNECTIONS:")
        for e in edges:
            lines.append(f"  {e['source']}:{e['sourceHandle']} -> {e['target']}:{e['targetHandle']}")

    lines.append("")
    return "\n".join(lines)


def format_selection(selection: dict[str, Any]) -> str:
    """Format the bounded live canvas selection for human and agent callers."""
    nodes = selection.get("nodes", [])
    if not nodes:
        return "No live canvas nodes selected."

    lines = [f"SELECTED NODES ({len(nodes)}):"]
    for node in nodes:
        node_id = node.get("id", "?")
        name = node.get("displayName") or node.get("definitionId") or "unknown"
        definition_id = node.get("definitionId", "unknown")
        lines.append(f"  {node_id:<8}{name} ({definition_id})")
        params = node.get("params")
        if params:
            lines.append(f"    params: {json.dumps(params, ensure_ascii=False, sort_keys=True)}")
        output_ports = node.get("outputPorts") or []
        if output_ports:
            lines.append(f"    outputs: {', '.join(str(port) for port in output_ports)}")

    connections = selection.get("connections", [])
    if connections:
        lines.append("")
        lines.append("RELATED CONNECTIONS:")
        for edge in connections:
            lines.append(
                f"  [{edge.get('relation', 'related')}] "
                f"{edge.get('source')}:{edge.get('sourceHandle')} -> "
                f"{edge.get('target')}:{edge.get('targetHandle')}"
            )

    missing = selection.get("missingNodeIds") or []
    if missing:
        lines.append("")
        lines.append("Ignored stale IDs: " + ", ".join(str(node_id) for node_id in missing))
    return "\n".join(lines)


def _price(value: Any) -> str:
    if value in ("free", "by input size"):
        return str(value)
    if isinstance(value, (list, tuple)) and len(value) == 2:
        low, high = float(value[0]), float(value[1])
        return _usd(high) if _usd(low) == _usd(high) else f"{_usd(low)}–{_usd(high)[1:]}"
    return "no list price"


def format_price_line(detail: dict[str, Any]) -> str | None:
    """`nebula info`'s PRICE line, from describe_node's answer
    (GET /api/agent/nodes/<id>): free, the price at default settings, the
    rate a node priced from its input's size is checked at, or no list price."""
    price = detail.get("price")
    if price == "free":
        return "PRICE: free"
    if not isinstance(price, dict):
        note = detail.get("priceNote")
        return f"PRICE: no list price. {note}" if note else "PRICE: no list price"
    unconfirmed = " (unconfirmed)" if price.get("unconfirmed") else ""
    if price.get("byInputSize"):
        return f"PRICE: {price['byInputSize']}{unconfirmed}"
    at = price.get("atDefaultsUsd")
    if isinstance(at, list) and len(at) == 2:
        billed = f" on {price['billedBy']}" if price.get("billedBy") else ""
        return f"PRICE: {_price(at)} per run at default settings{billed}{unconfirmed}"
    return "PRICE: no list price at default settings"


def format_start(start: dict[str, Any]) -> str:
    """Render GET /api/agent/start (services/agent_start.py) for `nebula context`:
    the canvas, pins, proposals, boards, the nodes that run here with prices,
    the spend limits and what to do next. The boards' `read` and `use` lines
    and NEXT's build, propose and point lines are the exact commands, so a
    first build needs neither `nebula apply --help` nor `nebula info
    nebula-moodboard`."""
    from services import node_categories

    lines: list[str] = []
    canvas = start.get("canvas") or {}
    project = canvas.get("project") or {}
    watching = "no browser watching" if (canvas.get("view") or {}).get("stale") else "open in the browser"
    title = f"{project.get('name')} ({project.get('id')})" if project else "no project open"
    lines.append(f"CANVAS: {title}, {canvas.get('nodeCount', 0)} nodes, {watching}")
    selection = canvas.get("selection") or []
    lines.append(f"  selected: {', '.join(selection) if selection else 'nothing'}")
    for agent in canvas.get("agents") or []:
        target = agent.get("target") or {}
        at = target.get("nodeId") or (f"({target.get('x')},{target.get('y')})" if target else "?")
        lines.append(f"  {agent.get('name')}'s cursor is at {at}")
    for node in canvas.get("nodes") or []:
        state = f" [{node['state']}]" if node.get("state") not in (None, "unknown", "idle") else ""
        inputs = f" <- {', '.join(node['inputsFrom'])}" if node.get("inputsFrom") else ""
        params = node.get("params") or {}
        shown = ", ".join(f"{key}={json.dumps(value, ensure_ascii=False)}" for key, value in params.items())
        more = f", +{node['moreParams']} more" if node.get("moreParams") else ""
        lines.append(f"  {node.get('id')}  {node.get('name')} ({node.get('definitionId')}){state}{inputs}")
        if shown:
            lines.append(f"      {shown}{more}")
    others = canvas.get("others") or {}
    if others:
        lines.append("  also: " + ", ".join(f"{node_id} {name}" for node_id, name in others.items()))
    if canvas.get("more"):
        lines.append(f"  ({canvas['more']})")

    pins = start.get("pins") or {}
    lines.append("")
    lines.append(f"PINS ({pins.get('openCount', 0)} open) — requests from the person:")
    for pin in pins.get("open") or []:
        anchor = pin.get("anchor") or {}
        at = anchor.get("nodeId") or f"({anchor.get('x')},{anchor.get('y')})"
        lines.append(f"  {pin.get('id')} on {at}: {json.dumps(pin.get('text') or '', ensure_ascii=False)}")
    if pins.get("more"):
        lines.append(f"  ({pins['more']})")

    proposals = start.get("proposals") or {}
    if proposals.get("count"):
        lines.append("")
        lines.append(f"PROPOSALS ({proposals['count']} waiting for the person):")
        for proposal in proposals.get("open") or []:
            note = json.dumps(str(proposal.get("note") or ""), ensure_ascii=False)
            lines.append(f"  {proposal.get('id')} by {proposal.get('agent')}: {note} "
                         f"(expires in {_minutes(proposal.get('expiresInSeconds'))}{_cant_run(proposal)})")
        if proposals.get("more"):
            lines.append(f"  ({proposals['more']})")

    boards = start.get("boards") or {}
    lines.append("")
    lines.append(f"BOARDS ({boards.get('count', 0)}):")
    for row in boards.get("rows") or []:
        analyzed = "analyzed" if row.get("analyzed") else "not analyzed"
        direction = f" — {row['direction']}" if row.get("direction") else ""
        lines.append(f"  {row.get('id')}  {row.get('name')} [{row.get('where')}] "
                     f"{row.get('images', 0)} images, {analyzed}{direction}")
    if boards.get("more"):
        lines.append(f"  ({boards['more']})")
    if boards.get("read"):
        lines.append(f"  {boards['read']}.")
    if boards.get("use"):
        lines.append(f"  {boards['use']}")

    nodes = start.get("nodes") or {}
    lines.append("")
    lines.append(f"NODES THAT RUN HERE ({nodes.get('ready', 0)} of {nodes.get('total', 0)}; "
                 "price per run at default settings):")
    for category, ids in (nodes.get("byCategory") or {}).items():
        listed = ", ".join(f"{node_id} {_price(price)}" for node_id, price in ids.items())
        lines.append(f"  {node_categories.label(category)}: {listed}")
    for access, ids in (nodes.get("runsWith") or {}).items():
        lines.append(f"  runs with {access}: {', '.join(ids)}")
    rest = nodes.get("rest") or {}
    if rest:
        lines.append("  not shown: " + ", ".join(f"{count} {category}" for category, count in rest.items()))
    for note in nodes.get("notes") or []:
        lines.append(f"  {note}")
    if nodes.get("krea"):
        lines.append(f"  Krea account: {nodes['krea']}")
    if nodes.get("more"):
        lines.append(f"  ({nodes['more']})")
    unready = int(nodes.get("total") or 0) - int(nodes.get("ready") or 0)
    if unready > 0:
        # `nebula nodes` is find_nodes' twin: what runs here by default, the rest with --all.
        lines.append(f"  ({unready} more can't run here yet: `nebula nodes --all` lists them with what each needs)")

    spend = start.get("spend") or {}
    lines.append("")
    per_run = spend.get("perRunUsd")
    per_run_text = f"{_usd(float(per_run))} per run" if isinstance(per_run, (int, float)) else "no per-run limit"
    if not spend.get("limited", True):
        lines.append(f"SPEND: not limited ({per_run_text} for agents)")
    else:
        limit = spend.get("limitUsd")
        used = float(spend.get("usedUsd") or 0)
        window = f" in the last {spend['window']}" if spend.get("window") else ""
        budget = (f"{_usd(used)} of {_usd(float(limit))} used{window}" if isinstance(limit, (int, float))
                  else f"{_usd(used)} used{window}, no budget limit")
        if spend.get("budget") == "app":
            shared_limit = spend.get("sharedLimitUsd")
            shared_used = float(spend.get("sharedUsedUsd") or 0)
            budget += (f"; every outside agent together {_usd(shared_used)} of {_usd(float(shared_limit))}"
                       if isinstance(shared_limit, (int, float))
                       else f"; every outside agent together {_usd(shared_used)}, no limit")
        plan = spend.get("kreaPlanRuns") or {}
        plan_limit = plan.get("limit")
        plan_text = f"Krea plan runs {plan.get('used') or 0} of {plan_limit if plan_limit is not None else 'no limit'}"
        lines.append(f"SPEND: {per_run_text}; {spend.get('budget')} budget {budget}; {plan_text}")
        lines.append("  (a run over a limit goes through `nebula propose`; `nebula spend` has the detail)")

    nxt = start.get("next") or {}
    events = nxt.get("events") or {}
    lines.append("")
    lines.append("NEXT:")
    for key in ("describe", "build", "propose", "point", "pins"):
        if nxt.get(key):
            lines.append(f"  {nxt[key]}")
    lines.append(f"  Events cursor {events.get('cursor')} (journal {events.get('journal')}).")
    return "\n".join(lines)


def format_run_results(results: dict[str, Any], node_defs: dict[str, dict[str, Any]] | None = None) -> str:
    """Format execution results."""
    outputs = results.get("results", {})
    errors = results.get("errors", {})
    duration = results.get("duration", 0)

    lines: list[str] = []
    for nid, node_outputs in outputs.items():
        if isinstance(node_outputs, dict):
            for port_id, port_val in node_outputs.items():
                val = port_val.get("value", "") if isinstance(port_val, dict) else port_val
                lines.append(f"{nid}: {val}")
        else:
            lines.append(f"{nid}: done")

    for nid, notes in (results.get("notes") or {}).items():
        for note in notes:
            lines.append(f"{nid}: note — {note}")

    for nid, err in errors.items():
        lines.append(f"{nid}: ERROR — {err}")

    # A gate upstream withheld these nodes' input, so they never ran (and cost nothing).
    for nid, reason in (results.get("skipped") or {}).items():
        lines.append(f"{nid}: skipped — {reason}")

    if duration is not None:
        lines.append(f"\nCompleted in {duration}s")
    return "\n".join(lines)


def _brief(value: Any, limit: int = 70) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _node_lines(node: dict[str, Any], *, open_on_canvas: bool = True) -> list[str]:
    """One node as look_at_canvas and get_project give it (`nebula look`,
    `nebula project show`): its line, then its error, an input's file name,
    params, a universal node's ports (from its model) and which outputs
    exist."""
    lines: list[str] = []
    pos = node.get("position")
    size = node.get("size")
    where = f"@({pos['x']:.0f},{pos['y']:.0f})" if pos else "@(?)"
    if size:
        where += f" {size['width']}×{size['height']}"
    screen = ""
    if node.get("onScreen") is False:
        screen = " off-screen"
    model = f" ({node['model']})" if node.get("model") else ""
    lines.append(f"  {node.get('id', '?'):<6}{node.get('name', '?')}{model} [{node.get('state', '?')}] {where}{screen}")
    if node.get("error"):
        # Why its last run failed, as the card says it.
        hint = f" ({node['errorHint']})" if node.get("errorHint") else ""
        lines.append(f"        error: {_brief(node['error'], 300)}{hint}")
    if node.get("fileName"):
        # The name its file was uploaded with (filePath is the stored copy).
        lines.append(f"        file: {json.dumps(str(node['fileName']), ensure_ascii=False)}")
    params = {k: v for k, v in (node.get("params") or {}).items() if v not in (None, "", {}, [])}
    if params:
        lines.append(f"        params: {_brief(params, 110)}")
    ports = node.get("ports")
    if isinstance(ports, dict):
        line = (f"        ports: in {', '.join(ports.get('inputs') or []) or '(none)'}"
                f" → out {', '.join(ports.get('outputs') or []) or '(none)'}")
        if ports.get("unconfirmed"):
            line += f" (unconfirmed: {', '.join(ports['unconfirmed'])})"
        lines.append(line)
    ready = [f"{port} ({info.get('type') or '?'})" for port, info in (node.get("outputs") or {}).items()
             if isinstance(info, dict) and info.get("available")]
    if ready:
        where_file = f"  (nebula path {node.get('id')} for the file)" if open_on_canvas else ""
        lines.append(f"        outputs ready: {', '.join(ready)}{where_file}")
    return lines


def format_snapshot(snapshot: dict[str, Any]) -> str:
    """Render GET /api/canvas/snapshot as a compact picture of the canvas."""
    lines: list[str] = []
    view = snapshot.get("view") or {}
    viewport = view.get("viewport")
    area = view.get("visibleArea")
    if not view.get("reported"):
        lines.append("VIEW: no browser has reported the canvas yet (positions/states unknown)")
    else:
        age = view.get("secondsAgo")
        stale = " — STALE, the canvas may be closed" if view.get("stale") else ""
        zoom = f"zoom {viewport['zoom']:.2f}" if viewport else "zoom ?"
        if area:
            span = (f"showing x {area['x']:.0f}…{area['x'] + area['width']:.0f}, "
                    f"y {area['y']:.0f}…{area['y'] + area['height']:.0f}")
        else:
            span = "visible area unknown"
        lines.append(f"VIEW: {zoom}, {span} (reported {age}s ago{stale})")

    selection = snapshot.get("selection") or []
    lines.append(f"SELECTED: {', '.join(selection) if selection else 'nothing'}")

    pins = [pin for pin in snapshot.get("pins") or [] if isinstance(pin, dict)]
    if pins:
        # Before NODES: the person's requests are the first thing an agent should read.
        open_count = sum(1 for pin in pins if pin.get("status") == "open")
        lines.append("")
        lines.append(f"PINS ({open_count} open) — notes from the person:")
        for pin in pins:
            lines.append(f"  {format_pin(pin)}")
        if open_count:
            lines.append('  (act on a note, then: nebula pin resolve <id> --say "...")')

    proposals = [p for p in snapshot.get("proposals") or [] if isinstance(p, dict)]
    if proposals:
        lines.append("")
        lines.append(f"PROPOSALS ({len(proposals)} waiting for the person):")
        for proposal in proposals:
            left = proposal.get("expiresInSeconds")
            expires = f" (expires in {_minutes(left)}{_cant_run(proposal)})" if isinstance(left, (int, float)) else ""
            note = json.dumps(str(proposal.get("note") or ""), ensure_ascii=False)
            lines.append(f"  {proposal.get('id', '?')} by {proposal.get('agent') or 'an agent'}: {note}{expires}")
        lines.append("  (nebula proposal <id> --wait to hear the decision)")

    nodes = snapshot.get("nodes") or []
    total = snapshot.get("nodeCount", len(nodes))
    truncated = " (truncated)" if snapshot.get("truncated") else ""
    lines.append("")
    lines.append(f"NODES ({total}){truncated}:")
    if not nodes:
        lines.append("  (canvas is empty)")
    for node in nodes:
        lines.extend(_node_lines(node))

    edges = snapshot.get("edges") or []
    if edges:
        lines.append("")
        lines.append("WIRES:")
        for edge in edges:
            lines.append(f"  {edge.get('source')}.{edge.get('sourceHandle')} → {edge.get('target')}.{edge.get('targetHandle')}")

    agents = snapshot.get("agents") or []
    if agents:
        lines.append("")
        lines.append("AGENT CURSORS:")
        for agent in agents:
            target = agent.get("target") or {}
            if "nodeId" in target:
                at = target["nodeId"] + (f".{target['handle']}" if target.get("handle") else "")
            else:
                at = f"({target.get('x', 0):.0f},{target.get('y', 0):.0f})"
            say = f' "{agent["say"]}"' if agent.get("say") else ""
            lines.append(f"  {agent.get('name')} at {at}{say} ({agent.get('secondsAgo')}s ago)")

    events = snapshot.get("events")
    if isinstance(events, dict) and events.get("cursor") is not None:
        lines.append("")
        lines.append(f"EVENTS: cursor {events['cursor']} (nebula watch --since {events['cursor']})")
    return "\n".join(lines)


def _ago(iso: Any, now: float | None = None) -> str:
    from datetime import datetime
    import time as _time

    if not isinstance(iso, str):
        return ""
    try:
        seconds = max(0, int((now if now is not None else _time.time()) - datetime.fromisoformat(iso).timestamp()))
    except ValueError:
        return ""
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{seconds // 60}m ago"
    if seconds < 86400:
        return f"{seconds // 3600}h ago"
    return f"{seconds // 86400}d ago"


def format_pin(pin: dict[str, Any], now: float | None = None) -> str:
    """One pin as `pin_8c41d2aa on n4: "warmer" (12m ago)`."""
    anchor = pin.get("anchor") or {}
    if "nodeId" in anchor:
        where = f"on {anchor['nodeId']}"
    else:
        try:
            where = f"at ({float(anchor.get('x', 0)):.0f},{float(anchor.get('y', 0)):.0f})"
        except (TypeError, ValueError):
            where = "on the canvas"
        if pin.get("detached") and pin.get("detachedFrom"):
            where += f" (its node {pin['detachedFrom']} was removed)"
    text = json.dumps(str(pin.get("text") or ""), ensure_ascii=False)
    reply = pin.get("reply") or {}
    if pin.get("status") == "resolved" and reply:
        agent = (reply.get("agent") or {}).get("name") or "an agent"
        answer = json.dumps(str(reply.get("text") or ""), ensure_ascii=False)
        return f"{pin.get('id', '?')} {where}: {text} — resolved by {agent}: {answer}"
    ago = _ago(pin.get("createdAt"), now)
    return f"{pin.get('id', '?')} {where}: {text}" + (f" ({ago})" if ago else "")


def _actor_label(actor: dict[str, Any] | None) -> str:
    actor = actor or {}
    if actor.get("kind") == "agent":
        return str(actor.get("name") or "Agent")
    if actor.get("kind") == "person":
        return "Person"
    if actor.get("kind") == "system":  # Nebula itself, e.g. a proposal expiring
        return "Nebula"
    return "Unnamed client"


def format_event(event: dict[str, Any]) -> str:
    """One journal event as `[57] 14:03:08  Person  moved n3, n4`."""
    import time as _time

    at = event.get("at")
    clock = _time.strftime("%H:%M:%S", _time.localtime(at / 1000)) if isinstance(at, (int, float)) else "--:--:--"
    kind = str(event.get("kind") or "")
    data = event.get("data") or {}
    summary = str(event.get("summary") or kind)
    if kind == "canvas.replaced":
        summary = f"Canvas replaced ({data.get('reason') or 'import'}) — node ids restarted; run nebula look"
    elif kind == "canvas.cleared":
        summary = "Cleared the canvas — run nebula look"
    elif kind == "node.params" and data.get("values"):
        shown = ", ".join(
            f"{key}={_brief(json.dumps(value, ensure_ascii=False) if isinstance(value, str) else value, 40)}"
            for key, value in list(data["values"].items())[:3]
        )
        summary = f"{summary}: {shown}"
    elif kind == "run.failed" and data.get("error"):
        summary = f"{summary}: {_brief(data['error'], 100)}"
    elif kind == "run.skipped" and data.get("reason"):
        summary = f"{summary}: {_brief(data['reason'], 100)}"
    elif kind == "pin.added" and data.get("pinId"):
        summary = f"{summary} — nebula pin resolve {data['pinId']} --say \"...\" when done"
    elif kind == "pin.resolved" and data.get("pinId"):
        summary = f"answered note {data['pinId']}: {_brief(data.get('reply') or '', 100)}"
    elif kind == "pin.removed" and data.get("pinId"):
        summary = f"deleted note {data['pinId']}"
    elif kind == "proposal.created" and data.get("proposalId"):
        summary = f"{summary} — waiting for the person (nebula proposal {data['proposalId']} --wait)"
    elif kind == "proposal.accepted" and data.get("proposalId"):
        mapped = ", ".join(f"{ref} → {node_id}" for ref, node_id in (data.get("idMap") or {}).items())
        runs = data.get("runNodeIds") or []
        summary = f"accepted proposal {data['proposalId']}" + (f": {mapped}" if mapped else "")
        if runs:
            summary += f"; the canvas will run {', '.join(runs)}"
    elif kind == "proposal.rejected" and data.get("proposalId"):
        reason = f': "{_brief(data["reason"], 100)}"' if data.get("reason") else ""
        summary = f"rejected proposal {data['proposalId']}{reason}"
    elif kind == "proposal.reopened" and data.get("proposalId"):
        summary = (f"{summary} — waiting for the person again "
                   f"(nebula proposal {data['proposalId']} --wait)")
    return f"[{event.get('seq', '?')}] {clock}  {_actor_label(event.get('actor'))}  {summary}"


def format_events(response: dict[str, Any]) -> str:
    return "\n".join(format_event(event) for event in response.get("events") or [])


def _cant_run(proposal: dict[str, Any]) -> str:
    """"; 1 node can't run here" for a proposal brief with `cantRun` (canvas_proposals.brief)."""
    count = proposal.get("cantRun")
    if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
        return ""
    return f"; {count} node{'s' if count != 1 else ''} can't run here"


def _minutes(seconds: Any) -> str:
    try:
        seconds = max(0, int(seconds))
    except (TypeError, ValueError):
        return "?"
    if seconds < 60:
        return f"{seconds}s"
    return f"{round(seconds / 60)} min"


def _cost_line(cost: dict[str, Any]) -> str:
    paid = int(cost.get("paidRuns") or 0)
    free = int(cost.get("freeRuns") or 0)
    up_to = "up to " if cost.get("upTo") else ""
    if paid == 0:
        return f"{up_to}{free} free run{'s' if free != 1 else ''} (runs locally)"
    providers = ", ".join(cost.get("providers") or [])
    line = f"{up_to}{paid} paid run{'s' if paid != 1 else ''}" + (f" ({providers})" if providers else "")
    if free:
        line += f" and {free} free"
    estimate = cost.get("estimate")
    if not estimate or estimate.get("high") is None:
        return line + " — no list price"
    low, high = float(estimate.get("low") or 0), float(estimate["high"])
    amount = _usd(high) if _usd(low) == _usd(high) else f"{_usd(low)}–{_usd(high)[1:]}"
    return line + f" — {amount}{'+' if estimate.get('open') else ''} at list prices"


def _usd(amount: float) -> str:
    """Matches the canvas: cents from a dime up, two significant figures below."""
    if amount <= 0:
        return "$0"
    if amount >= 10:
        return f"${round(amount)}"
    if amount >= 0.1:
        return f"${amount:.2f}"
    return f"${float(f'{amount:.2g}'):g}"


def format_proposal(view: dict[str, Any], *, created: bool = False, now_ms: float | None = None) -> str:
    """A proposal as the person will see it: what it adds, wires, sets and runs."""
    import time as _time

    proposal_id = view.get("id", "?")
    status = view.get("status") or "open"
    now = now_ms if now_ms is not None else _time.time() * 1000
    left = (float(view.get("expiresAt") or 0) - now) / 1000
    where = _ASSET_DECIDE_IN.get(str(view.get("decideIn") or "")) if view.get("kind") else None
    if created:
        head = f"Proposal {proposal_id} is {where or 'on the canvas'} for the person (expires in {_minutes(left)})."
    else:
        agent = (view.get("agent") or {}).get("name") or "an agent"
        when = f", expires in {_minutes(left)}" if status == "open" else ""
        reason = f" — {view['reason']}" if view.get("reason") and status != "open" else ""
        note = json.dumps(str(view.get("note") or ""), ensure_ascii=False)
        head = f"{proposal_id} by {agent} [{status}{when}]{reason}: {note}"
    lines = [head]
    if view.get("kind"):
        # A project's or a board's (services/asset_proposals.py): what it changes, no graph.
        lines.extend(_asset_change_lines(view, where))
        if created:
            lines.append(f"Check the outcome: nebula proposal {proposal_id} --wait")
        return "\n".join(lines)
    for node in view.get("nodes") or []:
        cost = (node.get("cost") or {}).get("label") or "?"
        pos = node.get("position") or {}
        try:
            where = f"  @({float(pos.get('x', 0)):.0f},{float(pos.get('y', 0)):.0f})"
        except (TypeError, ValueError):
            where = ""
        lines.append(f"  adds   {node.get('ref')}  {node.get('name') or node.get('definitionId')}  [{cost}]{where}")
    for edge in view.get("edges") or []:
        lines.append(f"  wires  {edge.get('source')}.{edge.get('sourceHandle')} → {edge.get('target')}.{edge.get('targetHandle')}")
    for change in view.get("params") or []:
        keys = ", ".join((change.get("changes") or {}).keys())
        lines.append(f"  sets   {change.get('nodeId')}: {keys}")
    run = view.get("run") or []
    if run:
        lines.append(f"  runs   {', '.join(run)} — {_cost_line(view.get('cost') or {})}")
    else:
        lines.append("  runs   nothing until the person chooses")
    if status == "open":
        # The run's nodes that can't run here: if the person accepts, it fails at them.
        for row in (view.get("cost") or {}).get("notReady") or []:
            if isinstance(row, dict):
                lines.append(f"  can't  {row.get('ref') or row.get('nodeId')}  {row.get('name') or ''}: "
                             f"{row.get('missing') or 'not set up here'}")
    if created:
        lines.append(f"Check the outcome: nebula proposal {proposal_id} --wait")
    return "\n".join(lines)


def format_applied(result: dict[str, Any], *, undo: bool = True) -> str:
    """`nebula apply`'s result: what changed, then each new node's id for the
    next command, then how to undo it (a steps plan prints one undo line for
    all its steps instead, so `undo=False` there)."""
    lines = [f"Applied: {result.get('summary') or 'no change'}."]
    refs = {node_id: ref for ref, node_id in (result.get("idMap") or {}).items()}
    for node in result.get("added") or []:
        node_id = str(node.get("id") or "")
        lines.append(f"  {refs.get(node_id, '?')} → {node_id}  {node.get('name') or node.get('definitionId') or ''}".rstrip())
    arrange = result.get("arrange")
    if isinstance(arrange, dict) and arrange.get("message"):
        lines.append(f"  Arrange: {arrange['message']}")
    # Universal nodes (OpenRouter, Nous Portal, Replicate) whose model was set:
    # the ports it gave them, or why they have only their basic ones.
    for node_id, ports in (result.get("modelPorts") or {}).items():
        if isinstance(ports, dict):
            lines.append(f"  Ports of {node_id} ({ports.get('model')}): in {', '.join(ports.get('inputs') or []) or '-'}; "
                         f"out {', '.join(ports.get('outputs') or []) or '-'}")
    for node_id, note in (result.get("modelPortNotes") or {}).items():
        lines.append(f"  Ports of {node_id}: {note}")
    # Placeholders (Q125 item 3): the nodes this apply made pending, or made ready.
    if result.get("pending"):
        lines.append(f"  Placeholders (runs skip them until ready): {', '.join(result['pending'])}. "
                     f"When they're ready: nebula apply --ready {' --ready '.join(result['pending'])}")
    if "ready" in result:
        lines.append(f"  Ready: {', '.join(result['ready']) or 'none'}"
                     + (f"; not placeholders: {', '.join(result['notPending'])}" if result.get("notPending") else ""))
    token = (result.get("undo") or {}).get("token") if undo else None
    if token:
        minutes = int((result["undo"].get("expiresInSeconds") or 0) // 60)
        lines.append(f"  Undo: nebula undo {token}  (for {minutes} minutes; parts changed or run since stay)")
    return "\n".join(lines)




def format_undone(result: dict[str, Any]) -> str:
    """`nebula undo`'s result: what went back, then each part left as it was."""
    status = result.get("status")
    if status == "already-undone":
        return result.get("message") or "Already undone; nothing changed."
    if status == "skipped":
        # The server's message lists each part too (for MCP and HTTP callers);
        # here they go on their own lines below, so line one leaves them out.
        lines = [nothing_went_back(result.get("skipped") or [])]
    else:
        done = ", ".join(f"{verb} {len(result.get(key) or [])}" for key, verb in UNDONE_VERBS if result.get(key))
        # Not the server's message when nothing was counted: it lists the parts
        # left too, and they go on their own lines below.
        lines = [f"Undone: {done}." if done else (
            "Undone: no change." if result.get("skipped") or result.get("undoId") else
            result.get("message") or "Undone: no change.")]
    # What the edit's deletes removed, put back with the nodes (GM, 2026-10-23).
    pins = result.get("reattached") or []
    if pins:
        lines.append(f"  Back on {'its node' if len(pins) == 1 else 'their nodes'}: {', '.join(pins)}")
    for row in result.get("pinsLeft") or []:
        lines.append(f"  Couldn't re-attach {row.get('id')}: {row.get('reason')}")
    reopened = result.get("reopened") or []
    if reopened:
        lines.append(f"  Reopened: {', '.join(reopened)}")
    for row in result.get("notReopened") or []:
        lines.append(f"  Couldn't reopen {row.get('id')}: {row.get('reason')}")
    for item in result.get("skipped") or []:
        lines.append(f"  Left as is: {item.get('message') or item.get('reason')}")
    return "\n".join(lines)


def format_step_stop(number: int, total: int, reason: str, applied: list[dict[str, Any]]) -> str:
    """Why a steps plan stopped, and what the steps before it left on the canvas."""
    lines = [f"error: step {number} of {total} was refused, so it and the steps after it weren't applied: {reason}"]
    if not applied:
        lines.append("Nothing was applied.")
        return "\n".join(lines)
    done = "Step 1 was applied and stays" if len(applied) == 1 else f"Steps 1-{len(applied)} were applied and stay"
    lines.append(f"{done} on the canvas:")
    for index, result in enumerate(applied, start=1):
        mapped = ", ".join(f"{ref} → {node_id}" for ref, node_id in (result.get("idMap") or {}).items())
        lines.append(f"  step {index}: {result.get('summary') or 'no change'}" + (f" ({mapped})" if mapped else ""))
    rest = f"step {number}" if number == total else f"steps {number}-{total}"
    lines.append(f"To finish, fix step {number} and apply {rest} on their own, "
                 "using the node ids above in place of those +refs.")
    return "\n".join(lines)


# Where the person decides an asset proposal (its view's `decideIn`).
_ASSET_DECIDE_IN = {"projects": "on the Projects screen", "moodboard-studio": "in Moodboard Studio",
                    "commons": "in the Commons"}


def _asset_value(value: Any) -> str:
    if value is None:
        return "automatic"
    return ("on" if value else "off") if isinstance(value, bool) else str(value)


def _commons_edit_line(edit: Any) -> str:
    """One commons proposal edit (services/commons_proposals.py) in one line."""
    if not isinstance(edit, dict) or len(edit) != 1:
        return "  sets   ?"
    what, body = next(iter(edit.items()))
    body = body if isinstance(body, dict) else {}
    if what == "correction":
        leaf = str(body.get("field_path") or "?").removesuffix(".value")
        value = json.dumps(body.get("value"), ensure_ascii=False)
        if leaf == "keywords":
            return f"  sets   keywords {'+' if body.get('op') == 'add' else '−'} {value}"
        return f"  sets   {leaf} → {value}"
    if what == "region" and "id" not in body:
        return f"  sets   new region {json.dumps(str(body.get('label') or ''), ensure_ascii=False)} at {body.get('box')}"
    # Text the agent wrote (label, note, why) is quoted; a role, status or box isn't.
    parts = [f"{key} {json.dumps(value, ensure_ascii=False) if key in ('label', 'note', 'why') else value}"
             for key, value in body.items() if key != "id"]
    return f"  sets   {what} {body.get('id')}: {', '.join(parts)}"


def _asset_change_lines(view: dict[str, Any], where: str | None) -> list[str]:
    lines = [f"  asks   {view.get('summary') or 'a change'}"]
    if view.get("kind") == "commons":
        lines.extend(_commons_edit_line(edit) for edit in (view.get("change") or {}).get("edits") or [])
    for key, values in (view.get("change") or {}).items():
        if isinstance(values, dict):
            label = {"cover": "cover", "sendNotes": "send notes"}.get(key, key)
            lines.append(f"  sets   {label}: {_asset_value(values.get('from'))} → {_asset_value(values.get('to'))}")
            lost = values.get("lostPin") if key == "cover" else None
            if isinstance(lost, dict):
                lines.append(f"  was    pinned {lost.get('url')}, whose image is gone: that pin no longer counts")
    if where and view.get("status", "open") == "open":
        lines.append(f"  decide {where}")
    return lines


def format_proposal_outcome(view: dict[str, Any]) -> str:
    """The person's decision in one line, for `--wait`."""
    status = view.get("status")
    if status == "accepted" and view.get("kind"):
        applied = view.get("applied") or {}
        if "cover" in applied:
            return ("Accepted by the person: the cover is automatic again." if applied["cover"] is None
                    else f"Accepted by the person: the cover is now {applied['cover']}.")
        if applied.get("sendNotes"):
            return "Accepted by the person: the board's notes now go to generators."
        if isinstance(applied.get("edits"), list):
            count = len(applied["edits"])
            return f"Accepted by the person: {count} change{'' if count == 1 else 's'} made to the reference."
        return "Accepted by the person."
    if status == "accepted":
        mapped = ", ".join(f"{ref} → {node_id}" for ref, node_id in (view.get("idMap") or {}).items())
        line = "Accepted by the person" + (f": {mapped}." if mapped else ".")
        runs = view.get("runNodeIds") or []
        if runs:
            line += f" They will run {', '.join(runs)} from the canvas."
        return line
    if status == "rejected":
        return f'Rejected: "{view["reason"]}"' if view.get("reason") else "Rejected (no reason given)."
    if status == "invalidated":
        return f"Invalidated: {view.get('reason') or 'the canvas changed'}"
    if status == "expired":
        return "Expired: the person didn't decide within 15 minutes."
    if status == "withdrawn":
        return "Withdrawn."
    return f"Still open ({view.get('id')})."


def _when_ms(value: Any) -> str:
    from datetime import datetime

    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return ""
    try:
        return datetime.fromtimestamp(value / 1000).strftime("%Y-%m-%d %H:%M")
    except (OverflowError, OSError, ValueError):
        return ""


def format_project(view: dict[str, Any]) -> str:
    """A saved project as MCP get_project reads it (nebula project show)."""
    project_id = view.get("id")
    is_open = view.get("open") is True
    updated = str(view.get("updatedAt") or "")[:16].replace("T", " ")
    state = "open on the canvas" if is_open else "closed"
    lines = [f"PROJECT {view.get('name')} ({project_id}), {state}" + (f"; updated {updated}" if updated else "")]
    by = view.get("createdBy")
    if isinstance(by, dict):
        lines.append(f"MADE BY: {_actor_label(by)}")
    cover = view.get("cover")
    if isinstance(cover, dict):
        images = [image for image in cover.get("images") or [] if isinstance(image, str)]
        lines.append(f"COVER: {cover.get('source') or '?'}" + (f", {', '.join(images[:4])}" if images else ""))

    nodes = view.get("nodes") or []
    truncated = " (truncated)" if view.get("truncated") else ""
    lines.append("")
    lines.append(f"NODES ({view.get('nodeCount', len(nodes))}){truncated}:")
    if not nodes:
        lines.append("  (empty)")
    for node in nodes:
        lines.extend(_node_lines(node, open_on_canvas=is_open))

    edges = view.get("edges") or []
    if edges:
        lines.append("")
        lines.append("WIRES:")
        for edge in edges:
            lines.append(f"  {edge.get('source')}.{edge.get('sourceHandle')} → {edge.get('target')}.{edge.get('targetHandle')}")

    runs = [run for run in view.get("runHistory") or [] if isinstance(run, dict)]
    count = view.get("runHistoryCount", len(runs))
    if runs:
        lines.append("")
        newest = f"newest {len(runs)} of {count}" if count != len(runs) else str(count)
        lines.append(f"RUN HISTORY ({newest}):")
        for run in runs:
            parts = [str(run.get("id")), str(run.get("status") or "?")]
            if run.get("trigger"):
                parts.append(str(run["trigger"]))
            started = _when_ms(run.get("startedAt"))
            if started:
                parts.append(started)
            if isinstance(run.get("durationSec"), (int, float)):
                parts.append(f"{run['durationSec']:g}s")
            ran = run.get("nodeIds") or []
            if ran:
                parts.append(f"ran {', '.join(ran)}")
            made = [f"{node_id}.{port}" for node_id, ports in (run.get("outputs") or {}).items()
                    if isinstance(ports, dict)
                    for port, info in ports.items() if isinstance(info, dict) and info.get("available")]
            if made:
                parts.append(f"made {', '.join(made)}")
            lines.append("  " + "  ".join(parts))
            if run.get("statusNote"):
                lines.append(f"        note: {_brief(run['statusNote'], 200)}")

    lines.append("")
    if is_open:
        lines.append("It is open: `nebula look` shows it live.")
    else:
        lines.append(f"`nebula project open {project_id}` opens it; outputs' files (`nebula path`) are read once it is open.")
    return "\n".join(lines)


# -- questions for the person (Q125 item 1) -----------------------------------------

_QUESTION_STATUS = {
    "open": "waiting for the person",
    "answered": "answered",
    "dismissed": "dismissed by the person (no answers)",
    "withdrawn": "withdrawn",
}


def format_questions(view: dict[str, Any]) -> str:
    """A question set and, once answered, each answer (or "No answer.")."""
    set_id = view.get("id", "?")
    status = str(view.get("status") or "open")
    questions = [q for q in view.get("questions") or [] if isinstance(q, dict)]
    count = len(questions)
    lines = [f"{set_id} [{_QUESTION_STATUS.get(status, status)}]: {count} question{'' if count == 1 else 's'}"]
    if view.get("note"):
        lines[0] += f" ({json.dumps(str(view['note']), ensure_ascii=False)})"
    answers = {str(a.get("questionId")): a for a in view.get("answers") or [] if isinstance(a, dict)}
    for question in questions:
        options = question.get("options") or []
        how = []
        if options:
            how.append(("any of: " if question.get("multiple") else "one of: ") + " / ".join(map(str, options)))
        if question.get("allowText", True):
            how.append("or typed" if options else "typed")
        lines.append(f"  {question.get('id')}. {question.get('text')}  [{', '.join(how)}]")
        if status == "answered":
            answer = answers.get(str(question.get("id"))) or {}
            if not answer.get("answered"):
                lines.append("     → No answer.")
                continue
            if answer.get("choices"):
                lines.append(f"     → {', '.join(map(str, answer['choices']))}")
            if answer.get("text"):
                text = str(answer["text"]).replace("\n", "\n       ")
                lines.append(f"     → \"{text}\"")
    return "\n".join(lines)


def _seconds_ago(seconds: Any) -> str:
    if not isinstance(seconds, (int, float)):
        return ""
    if seconds < 60:
        return "just now"
    minutes = int(seconds // 60)
    if minutes < 60:
        return f"{minutes} min ago"
    return f"{minutes // 60} h ago"


def needs_you_line(counts: dict[str, Any]) -> str:
    """'1 question', '2 proposals', '1 question, 1 proposal' (GM's count line)."""
    parts = []
    for key, one, many in (("questions", "question", "questions"), ("proposals", "proposal", "proposals")):
        count = int(counts.get(key) or 0)
        if count:
            parts.append(f"{count} {one if count == 1 else many}")
    return ", ".join(parts)


def format_agents(roster: dict[str, Any]) -> str:
    """`nebula agents`: the roster as the Agents panel groups it (MCP list_agents)."""
    agents = roster.get("agents") or []
    if not agents:
        return "No agents are around in the open project."
    lines: list[str] = []
    for group, heading in (("needsYou", "Needs you"), ("working", "Working")):
        rows = [entry for entry in agents if entry.get("group") == group]
        if not rows:
            continue
        lines.append(heading)
        for entry in rows:
            agent = entry.get("agent") or {}
            name = str(agent.get("name") or "Agent") + ("" if agent.get("verified") else " (named itself)")
            status = entry.get("status")
            action = entry.get("lastAction")
            if status:
                detail = str(status.get("text") or "") + (f" ({status['nodeId']})" if status.get("nodeId") else "")
            elif action:
                label = f" “{action['label']}”" if action.get("label") else ""
                node = f" ({action['nodeId']})" if action.get("nodeId") else ""
                detail = f"{action.get('verb')}{label}{node} · {_seconds_ago(action.get('secondsAgo'))}"
            else:
                detail = ""
            parts = [name]
            if group == "needsYou":
                parts.append(needs_you_line(entry.get("needsYou") or {}))
                if entry.get("waitingSeconds") is not None:
                    parts.append(f"waiting since {_seconds_ago(entry['waitingSeconds'])}".replace("since just now", "just now"))
            elif detail:
                parts.append(detail)
            lines.append("  " + " · ".join(part for part in parts if part))
            if group == "needsYou" and detail:
                lines.append(f"    {detail}")
            # Q125 item 3: what its runs are running now, and its placeholders.
            for running in entry.get("running") or []:
                seconds = int(float(running.get("secondsAgo") or 0))
                lines.append(f"    Running {running.get('model') or running.get('nodeId')} ({running.get('nodeId')})"
                             f" · {seconds // 60}:{seconds % 60:02d}")
            pending = entry.get("pending") or []
            if pending:
                lines.append(f"    {len(pending)} placeholder{'' if len(pending) == 1 else 's'} (runs skip them): "
                             f"{', '.join(pending)}")
    return "\n".join(lines)
