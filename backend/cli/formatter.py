from __future__ import annotations

import json
from typing import Any

# The readiness rule lives with the backend so the CLI and MCP server agree.
from services.node_readiness import detail, krea_modes, node_access, provider_via  # noqa: F401 (node_access is re-exported)
from services.agent_params import ASSET_PARAM_TYPES
from services.maker_sizes import rule_note
from services.node_route import all_param_definitions, route_hides, route_param_definitions


def format_node_table(nodes: list[dict[str, Any]]) -> str:
    """Format nodes as an aligned table grouped by category."""
    by_cat: dict[str, list[dict[str, Any]]] = {}
    for n in nodes:
        cat = n.get("category", "other")
        by_cat.setdefault(cat, []).append(n)

    cat_names = {
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

    lines: list[str] = []
    for cat, cat_nodes in by_cat.items():
        display_cat = cat_names.get(cat, cat.upper())
        lines.append(f"{display_cat} ({len(cat_nodes)})")
        for n in sorted(cat_nodes, key=lambda x: x["id"]):
            nid = n["id"]
            name = n.get("displayName", nid)
            provider = n.get("apiProvider", "")
            lines.append(f"  {nid:<30} {name:<25} {provider}")
        lines.append("")

    return "\n".join(lines)


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
    """Format API key status (nebula keys output)."""
    api_keys = settings.get("apiKeys", {})

    key_to_nodes: dict[str, list[str]] = {}
    all_keys: set[str] = set()
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

        masked = api_keys.get(key_name, "")
        if masked:
            configured.append(f"  {key_name:<25}{masked:<10}{count} nodes ({preview})")
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


def format_context(
    settings: dict[str, Any], nodes: list[dict[str, Any]], krea_status: str | None = None,
) -> str:
    """Compact summary of what can run right now, by definition id."""
    api_keys = settings.get("apiKeys", {})
    configured_keys = {k for k, v in api_keys.items() if v}
    krea_signed_in = krea_status == "connected"

    definitions = {n["id"]: n for n in nodes}
    by_cat: dict[str, list[str]] = {}
    access_count: dict[str, int] = {}
    krea_both: list[str] = []
    keyed_modes: list[str] = []   # free at defaults, a provider call in another mode
    base_notes: list[str] = []    # a node whose default model can't run but another can
    for n in nodes:
        access = node_access(n, configured_keys, krea_signed_in, definitions)
        if access is None:
            continue
        access_count[access] = access_count.get(access, 0) + 1
        if access == "krea" and krea_modes(n) != ["mcp"]:
            krea_both.append(n["id"])
        mark = {"krea": "*", "nous": "^"}.get(access, "")
        via = provider_via(n)
        if via and via.get("kind") == "param" and access == "free":
            mark = "+"
            keyed_modes.append(n["id"])
        options = detail(n, configured_keys, krea_signed_in, definitions) if via else None
        if via and via.get("kind") == "model" and options and options.get("note"):
            base_notes.append(f"{n['id']}: {options['note']}")
        by_cat.setdefault(n.get("category", "other"), []).append(n["id"] + mark)

    cat_names = {
        "image-gen": "Image", "video-gen": "Video", "text-gen": "Text/Chat",
        "audio-gen": "Audio", "3d-gen": "3D", "transform": "Transform",
        "analyzer": "Analyzer", "utility": "Utility", "universal": "Universal",
        "cinematic": "Cinema", "character": "Character",
    }

    ready = sum(access_count.values())
    lines: list[str] = []
    lines.append(f"Nebula Nodes — {ready} of {len(nodes)} nodes can run here")
    parts = [f"{access_count.get('key', 0)} with your keys", f"{access_count.get('free', 0)} free"]
    if access_count.get("krea"):
        parts.append(f"{access_count['krea']} on the Krea account")
    if access_count.get("nous"):
        parts.append(f"{access_count['nous']} with a Nous sign-in")
    lines.append("(" + ", ".join(parts) + ")")
    lines.append("")
    lines.append(f"Keys set: {', '.join(sorted(configured_keys)) or 'none'}")
    if krea_status is not None:
        if krea_signed_in:
            lines.append("Krea account: signed in")
        else:
            more = sum(1 for n in nodes if node_access(n, configured_keys, True) == "krea")
            lines.append(f"Krea account: not signed in ({krea_status})"
                         + (f"; signing in (Settings > Providers) adds {more} nodes" if more else ""))
    lines.append("")

    for cat, ids in by_cat.items():
        display = cat_names.get(cat, cat)
        lines.append(f"{display}: {', '.join(sorted(ids))}")

    lines.append("")
    if access_count.get("krea"):
        lines.append("* runs on the signed-in Krea account (workspace compute).")
        if krea_both:
            lines.append("  Those that also take a token default to it. Moving one to the Krea plan is the person's")
            lines.append("  call: `nebula propose` the _kreaAuth=mcp change; direct edits of it are refused.")
    multi = [n["id"] for n in nodes if isinstance(n.get("routes"), list) and n.get("routes")]
    if multi:
        lines.append(f"{len(multi)} node(s) run on a provider route you choose (_provider; `nebula info <id>` lists")
        lines.append("  them). Auto takes the first route with its key set; switching is the person's call:")
        lines.append("  `nebula propose` it.")
    if access_count.get("nous"):
        lines.append("^ needs a local Nous (Hermes) sign-in; not checked here.")
    legends: list[str] = []
    for node_id in keyed_modes:
        via = provider_via(definitions[node_id]) or {}
        keys = [str(key) for key in via.get("anyKey") or []]
        own = via.get("byValue") if isinstance(via.get("byValue"), dict) else {}
        skip = list(via.get("freeWhen") or []) + list(own)
        legend = (f"+ free at its defaults; {via.get('param')} other than {'/'.join(skip)} calls a "
                  f"{via.get('provider')} model with {' or '.join(keys)}"
                  f"{' (set here)' if any(key in configured_keys for key in keys) else ''}. No list price, "
                  "so under a spending limit that takes a proposal.")
        for value, route in own.items():
            route_keys = [str(key) for key in (route or {}).get("anyKey") or []]
            legend += (f" {via.get('param')} {value} calls {(route or {}).get('provider')} with "
                       f"{' or '.join(route_keys)}"
                       f"{' (set here)' if any(key in configured_keys for key in route_keys) else ''}, "
                       "priced per run.")
        if legend not in legends:
            legends.append(legend)
    lines.extend(legends)
    for note in base_notes:
        lines.append(note)
    lines.append("Ids above go to `nebula create <id>`; `nebula info <id>` shows ports and params.")
    lines.append("Port types: Text, Image, Video, Audio, Mesh, Array, SVG, Any")
    lines.append("Connections must match types (Any connects to anything).")
    lines.append("Paid runs over your spending limits need a proposal: `nebula spend` shows them.")

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
            expires = f" (expires in {_minutes(left)})" if isinstance(left, (int, float)) else ""
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
        params = {k: v for k, v in (node.get("params") or {}).items() if v not in (None, "", {}, [])}
        if params:
            lines.append(f"        params: {_brief(params, 110)}")
        ready = [f"{port} ({info.get('type') or '?'})" for port, info in (node.get("outputs") or {}).items()
                 if isinstance(info, dict) and info.get("available")]
        if ready:
            lines.append(f"        outputs ready: {', '.join(ready)}  (nebula path {node.get('id')} for the file)")

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
    return f"[{event.get('seq', '?')}] {clock}  {_actor_label(event.get('actor'))}  {summary}"


def format_events(response: dict[str, Any]) -> str:
    return "\n".join(format_event(event) for event in response.get("events") or [])


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
    if created:
        head = f"Proposal {proposal_id} is on the canvas for the person (expires in {_minutes(left)})."
    else:
        agent = (view.get("agent") or {}).get("name") or "an agent"
        when = f", expires in {_minutes(left)}" if status == "open" else ""
        reason = f" — {view['reason']}" if view.get("reason") and status != "open" else ""
        note = json.dumps(str(view.get("note") or ""), ensure_ascii=False)
        head = f"{proposal_id} by {agent} [{status}{when}]{reason}: {note}"
    lines = [head]
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
    token = (result.get("undo") or {}).get("token") if undo else None
    if token:
        minutes = int((result["undo"].get("expiresInSeconds") or 0) // 60)
        lines.append(f"  Undo: nebula undo {token}  (for {minutes} minutes; parts changed since stay)")
    return "\n".join(lines)


_UNDONE_VERBS = (("removed", "removed"), ("added", "put back"), ("changed", "reset"), ("renamed", "renamed"),
                 ("moved", "moved"))


def format_undone(result: dict[str, Any]) -> str:
    """`nebula undo`'s result: what went back, then each part left as it was."""
    status = result.get("status")
    if status == "already-undone":
        return result.get("message") or "Already undone; nothing changed."
    if status == "skipped":
        lines = [result.get("message") or "Nothing went back."]
    else:
        done = ", ".join(f"{verb} {len(result.get(key) or [])}" for key, verb in _UNDONE_VERBS if result.get(key))
        lines = [f"Undone: {done}." if done else (result.get("message") or "Undone: no change.")]
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


def format_proposal_outcome(view: dict[str, Any]) -> str:
    """The person's decision in one line, for `--wait`."""
    status = view.get("status")
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
